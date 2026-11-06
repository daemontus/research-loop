import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import { bindControlTools, CONTROL_TOOLS_BY_KIND } from "../agent/lib/control-tools.mjs";
import { makeCredentialStore } from "../agent/lib/model-providers.mjs";
import { PauseGate } from "../agent/lib/pause.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";
import { createBroker, readSessionLog } from "../control-plane/broker.mjs";
import { createEngine } from "../control-plane/engine.mjs";
import { startControlPlane } from "../control-plane/server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("PauseGate clock", () => {
  it("does not count paused time", () => {
    let now = 1000;
    const gate = new PauseGate({ now: () => now });
    assert.equal(gate.activeNow(), 1000);
    now = 1500;
    gate.set(true);
    now = 9500; // 8 s paused
    assert.equal(gate.activeNow(), 1500);
    assert.equal(gate.pausedMs(), 8000);
    gate.set(false);
    now = 10000;
    assert.equal(gate.activeNow(), 2000);
    assert.equal(gate.set(false), false, "unpausing twice is a no-op");
  });

  it("suspends timers and sleeps while paused", async () => {
    const gate = new PauseGate();
    let fired = false;
    gate.timeout(() => (fired = true), 60);
    const slept = gate.sleep(60).then(() => "slept");
    await sleep(20);
    gate.set(true);
    await sleep(120);
    assert.equal(fired, false, "a paused timer does not fire");
    assert.equal(await Promise.race([slept, sleep(0).then(() => "pending")]), "pending");
    gate.set(false);
    await sleep(80);
    assert.equal(fired, true, "fires after the remaining active time");
    assert.equal(await slept, "slept");
  });

  it("interrupts registered requests on pause and wakes waiters on resume", async () => {
    const gate = new PauseGate();
    let interrupted = 0;
    const release = gate.beginRequest(() => interrupted++);
    assert.equal(gate.inFlight(), 1);
    gate.set(true);
    assert.equal(interrupted, 1);
    release();
    assert.equal(gate.inFlight(), 0);
    let resumed = false;
    const wait = gate.waitUntilResumed().then(() => (resumed = true));
    await sleep(10);
    assert.equal(resumed, false);
    gate.set(false);
    await wait;
    assert.equal(resumed, true);
  });
});

describe("engine pause", () => {
  it("pauses only a running run, records paused time, and replays", () => {
    const engine = createEngine({ task: "t", skipSkills: true });
    assert.equal(engine.pause(1).ok, false, "not started yet");
    engine.start(10);
    assert.equal(engine.pause(100).ok, true);
    assert.equal(engine.pause(101).ok, false, "already paused");
    const snap = engine.snapshot();
    assert.equal(snap.paused, true);
    assert.equal(snap.pausedAt, 100);
    assert.equal(engine.unpause(400).ok, true);
    assert.equal(engine.snapshot().pausedMs, 300);
    assert.equal(engine.unpause(500).ok, false, "not paused");

    const replayed = createEngine({ task: "t", skipSkills: true });
    replayed.replay([
      { kind: "start", ts: 10 },
      { kind: "pause", ts: 100 },
      { kind: "unpause", ts: 400 },
      { kind: "pause", ts: 600 },
    ]);
    const r = replayed.snapshot();
    assert.equal(r.paused, true);
    assert.equal(r.pausedAt, 600);
    assert.equal(r.pausedMs, 300);
  });

  it("still accepts handoffs while paused, and ending the run ends the pause", () => {
    const engine = createEngine({ task: "t", skipSkills: true });
    engine.start(10);
    engine.pause(20);
    const goals = [{ id: "G1", title: "t", description: "d", acceptance: ["a"] }];
    assert.equal(engine.handoff("advisor", "root", { kind: "propose_plan", payload: { goals } }, 30).ok, true);
    engine.abortRun("stop", 50);
    assert.equal(engine.snapshot().paused, false);
    assert.equal(engine.snapshot().pausedMs, 30);
  });
});

function newBroker(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-pause-"));
  return { tmp, broker: createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, ...opts }) };
}

describe("broker pause", () => {
  it("wakes pending polls, reports paused on every poll, and logs pause/unpause", async () => {
    const { tmp, broker } = newBroker();
    broker.start();
    const first = await broker.poll("researcher", 0, 50);
    assert.equal(first.paused, false);
    const waiting = broker.poll("researcher", first.cursor, 5000);
    assert.equal(broker.pause().ok, true);
    const woke = await waiting;
    assert.equal(woke.paused, true, "a pending long-poll returns at once with the pause");
    assert.equal(woke.messages.length, 0);
    assert.equal((await broker.poll("advisor", 0, 10)).paused, true);
    assert.equal(broker.pause().ok, false);
    assert.equal(broker.snapshot().paused, true);
    assert.equal(broker.unpause().ok, true);
    assert.equal((await broker.poll("researcher", woke.cursor, 10)).paused, false);
    const kinds = readSessionLog(tmp).map((e) => e.kind);
    assert.ok(kinds.includes("pause") && kinds.includes("unpause"), kinds.join(","));
  });

  it("stays paused when the run is resumed from its control log", async () => {
    const { tmp, broker } = newBroker();
    broker.start();
    broker.pause();
    const resumed = createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, replayEntries: readSessionLog(tmp) });
    assert.equal(resumed.resume().ok, true);
    assert.equal(resumed.snapshot().paused, true);
    assert.equal((await resumed.poll("advisor", 0, 10)).paused, true);
    // The resume prompt is still delivered; the agent holds it until unpaused.
    assert.ok((await resumed.poll("advisor", 0, 10)).messages.length > 0);
    assert.equal(resumed.unpause().ok, true);
  });

  it("holds the pausable (wallclock) timer while paused", async () => {
    const { broker } = newBroker();
    broker.start();
    let fired = false;
    broker.pausableTimeout(() => (fired = true), 60);
    await sleep(20);
    broker.pause();
    await sleep(120);
    assert.equal(fired, false);
    broker.unpause();
    await sleep(80);
    assert.equal(fired, true);
  });

  it("shows each agent's pause status", () => {
    const { broker } = newBroker();
    broker.start();
    broker.pause();
    broker.agentPauseStatus("researcher", { paused: true, inFlight: 1 });
    assert.deepEqual(
      { paused: broker.snapshot().pauseAgents.researcher.paused, inFlight: broker.snapshot().pauseAgents.researcher.inFlight },
      { paused: true, inFlight: 1 },
    );
    assert.equal(broker.snapshot().pauseAgents.advisor, null);
  });
});

describe("pause over HTTP", () => {
  it("pauses and resumes through /api/pause and /api/unpause", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-pause-http-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({ token: "t", task: "x", transcriptDir, sessionId: "s", port: 0, skipSkills: true });
    try {
      const base = `http://127.0.0.1:${cp.port}`;
      const post = (p, token = "t") => fetch(`${base}${p}?token=${token}`, { method: "POST" });
      assert.equal((await post("/api/pause", "wrong")).status, 401);
      const r = await post("/api/pause");
      assert.equal(r.status, 200);
      assert.equal((await r.json()).state.paused, true);
      assert.equal((await post("/api/pause")).status, 409);
      const state = await (await fetch(`${base}/api/state?token=t`)).json();
      assert.equal(state.state.paused, true, "survives a UI reload");
      const u = await post("/api/unpause");
      assert.equal(u.status, 200);
      assert.equal((await u.json()).state.paused, false);
    } finally {
      cp.close();
    }
  });
});

// ---- agent side -------------------------------------------------------------

function makeSession(responses, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-pause-agent-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = builtinModels({ credentials: makeCredentialStore({}) });
  models.setProvider(faux.provider);
  const counted = { requests: 0 };
  const countingModels = {
    streamSimple: (...a) => {
      counted.requests += 1;
      return models.streamSimple(...a);
    },
  };
  const controlState = { pendingHandoff: null };
  const controller = {
    setHandoff: (h) => {
      if (controlState.pendingHandoff) return false;
      controlState.pendingHandoff = h;
      return true;
    },
  };
  const transcriptPath = path.join(tmp, "researcher.jsonl");
  const gate = opts.pauseGate || new PauseGate();
  const session = new AgentSession({
    role: "researcher",
    model: models.getModel("faux", "m1"),
    models: countingModels,
    systemPrompt: "You are the researcher.",
    tools: bindControlTools(CONTROL_TOOLS_BY_KIND.leaf.researcher, controller),
    sandbox: tmp,
    transcript: createTranscriptWriter(transcriptPath, "researcher"),
    controlState,
    maxTurnsPerPhase: 100,
    providerErrorBackoffMs: 1,
    random: () => 0.5,
    ...opts,
    pauseGate: gate,
  });
  session.start();
  faux.setResponses(responses);
  const notes = () =>
    fs
      .readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "system")
      .map((e) => e.content);
  return { session, gate, counted, notes };
}

const submit = () =>
  fauxAssistantMessage([fauxText("done"), fauxToolCall("submit_result", { summary: "s", report: "r", notes: "n" })], {
    stopReason: "toolUse",
  });
const fail = (errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

describe("agent session pause", () => {
  it("makes no model request while paused and continues after resume", async () => {
    const { session, gate, counted, notes } = makeSession([submit()]);
    gate.set(true);
    const run = session.runPrompt("work");
    await sleep(80);
    assert.equal(counted.requests, 0, "no request while paused");
    gate.set(false);
    const r = await run;
    assert.equal(r.error, null);
    assert.equal(counted.requests, 1);
    assert.equal(session.takeHandoff().kind, "submit_result");
    assert.ok(notes().some((n) => /^paused: waiting/.test(n)));
  });

  it("interrupts an in-flight request on pause and repeats the turn once after resume", async () => {
    let started;
    const inFlight = new Promise((r) => (started = r));
    const hanging = (_ctx, options) =>
      new Promise((resolve) => {
        started();
        options.signal.addEventListener("abort", () => resolve(submit()), { once: true });
      });
    const { session, gate, counted, notes } = makeSession([hanging, submit()], { maxAbortRetries: 0 });
    const run = session.runPrompt("work");
    await inFlight;
    gate.set(true);
    await sleep(80);
    assert.equal(gate.inFlight(), 0, "the interrupted request is released");
    assert.equal(counted.requests, 1, "nothing new while paused");
    gate.set(false);
    const r = await run;
    assert.equal(r.error, null);
    assert.equal(counted.requests, 2);
    assert.equal(session.phaseRetries.abort, 0, "a pause is not an abort retry");
    const h = session.takeHandoff();
    assert.equal(h.kind, "submit_result");
    assert.equal(session.takeHandoff(), null, "exactly one handoff");
    // The interrupted (aborted) assistant turn was dropped from the history.
    assert.equal(session.agent.state.messages.filter((m) => m.stopReason === "aborted").length, 0);
    assert.ok(notes().some((n) => /in-flight model request was interrupted/.test(n)));
  });

  it("does not let the abort timer fire while paused", async () => {
    const { session, gate } = makeSession([submit()], { abortTimeoutMs: 40, maxAbortRetries: 0 });
    gate.set(true);
    const run = session.runPrompt("work");
    await sleep(150);
    gate.set(false);
    const r = await run;
    assert.equal(r.error, null);
    assert.equal(session.abortRetries, 0);
    assert.equal(session.takeHandoff().kind, "submit_result");
  });

  it("does not count paused time against the phase timeout", async () => {
    // The provider fails once; the retry is only allowed while the phase
    // budget (100 ms) is not spent, and 200 ms of it are paused.
    const { session, gate } = makeSession([fail("500 internal error"), submit()], { phaseTimeoutMs: 100 });
    gate.set(true);
    const run = session.runPrompt("work");
    await sleep(200);
    gate.set(false);
    const r = await run;
    assert.equal(r.error, null);
    assert.equal(session.providerErrorRetries, 1);
    assert.equal(session.takeHandoff().kind, "submit_result");
  });

  it("does not spend the provider retry budget while paused", async () => {
    // Backoff 50 ms then 100 ms against a 200 ms budget; a 400 ms pause during
    // the first backoff would exhaust it if paused time counted.
    const { session, gate, notes } = makeSession([fail("502 bad gateway"), fail("502 bad gateway"), submit()], {
      providerErrorBackoffMs: 50,
      retryBudgetMs: 200,
    });
    const run = session.runPrompt("work");
    await sleep(10);
    gate.set(true);
    await sleep(400);
    gate.set(false);
    const r = await run;
    assert.equal(r.error, null, notes().join("\n"));
    assert.equal(session.providerErrorRetries, 2);
    assert.ok(!notes().some((n) => /giving up/.test(n)));
    assert.equal(session.takeHandoff().kind, "submit_result");
  });
});

describe("pause reaches an idle agent", () => {
  it("answers a poll at once when the agent's pause state is stale", async () => {
    const { broker } = newBroker();
    broker.start();
    const { cursor } = await broker.poll("researcher", 0, 10);
    broker.pause();
    const t0 = Date.now();
    const r = await broker.poll("researcher", cursor, 5000, false);
    assert.equal(r.paused, true);
    assert.ok(Date.now() - t0 < 1000, "not held for the long-poll");
    // An up-to-date agent still long-polls.
    const held = await broker.poll("researcher", cursor, 50, true);
    assert.equal(held.timedOut, true);
  });
});
