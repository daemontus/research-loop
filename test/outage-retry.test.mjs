import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentSession, backoffDelay, formatWait, retryAfterMs } from "../agent/lib/agent-runner.mjs";
import { bindControlTools, researcherControlToolDefs } from "../agent/lib/control-tools.mjs";
import { makeCredentialStore } from "../agent/lib/model-providers.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";

function makeSession(responses, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-outage-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = builtinModels({ credentials: makeCredentialStore({}) });
  models.setProvider(faux.provider);
  const controlState = { pendingHandoff: null };
  const controller = {
    setHandoff: (h) => {
      if (controlState.pendingHandoff) return false;
      controlState.pendingHandoff = h;
      return true;
    },
  };
  const transcriptPath = path.join(tmp, "researcher.jsonl");
  const session = new AgentSession({
    role: "researcher",
    model: models.getModel("faux", "m1"),
    models,
    systemPrompt: "You are the researcher.",
    tools: bindControlTools(researcherControlToolDefs(), controller),
    sandbox: tmp,
    transcript: createTranscriptWriter(transcriptPath, "researcher"),
    controlState,
    maxTurnsPerPhase: 100,
    providerErrorBackoffMs: 1,
    rateLimitBackoffMs: 1,
    random: () => 0.5, // no jitter
    ...opts,
  });
  faux.setResponses(responses);
  const notes = () =>
    fs
      .readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "system");
  return { session, notes };
}

const plan = () =>
  fauxAssistantMessage(
    [fauxText("plan"), fauxToolCall("submit_plan", { goalId: "G1", title: "t", plan: ["a"], acceptanceCriteria: ["b"] })],
    { stopReason: "toolUse" },
  );
const fail = (errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

describe("outage backoff schedule", () => {
  it("doubles from the base delay up to the cap", () => {
    const opts = { baseMs: 5000, maxDelayMs: 900000, random: () => 0.5 };
    assert.deepEqual(
      [0, 1, 2, 3, 7, 8, 20].map((n) => backoffDelay(n, opts)),
      [5000, 10000, 20000, 40000, 640000, 900000, 900000],
    );
    // +-20% jitter at the extremes.
    assert.equal(backoffDelay(0, { ...opts, random: () => 0 }), 4000);
    assert.equal(backoffDelay(0, { ...opts, random: () => 0.999999 }), 6000);
  });

  it("spends an 8h budget in roughly 40 attempts", () => {
    let t = 0;
    let n = 0;
    while (t < 8 * 3600e3) t += backoffDelay(n++, { baseMs: 5000, maxDelayMs: 900000, random: () => 0.5 });
    assert.ok(n > 30 && n < 45, `got ${n}`);
  });

  it("parses retry-after hints and formats waits", () => {
    assert.equal(retryAfterMs('429 {"error":"rate limited","retry_after": 12}'), 12000);
    assert.equal(retryAfterMs("Too many requests. Retry-After: 12"), 12000);
    assert.equal(retryAfterMs("please retry after 1.5 seconds"), 1500);
    assert.equal(retryAfterMs("HTTP 503"), 0);
    assert.equal(formatWait(512000), "8m 32s");
    assert.equal(formatWait(3900000), "1h 5m");
  });
});

describe("outage retries in a phase", () => {
  it("keeps retrying a transient error with growing waits and recovers", async () => {
    const { session, notes } = makeSession([
      fail("503 Service Unavailable"),
      fail("503 Service Unavailable"),
      fail("terminated"),
      fail("503 Service Unavailable"),
      fail("503 Service Unavailable"),
      plan(),
    ]);
    await session.start();
    const { error } = await session.runPrompt("go");
    assert.equal(error, null);
    assert.equal(session.takeHandoff()?.kind, "proposal");
    assert.equal(session.stats().providerErrorRetries, 5, "more than the old cap of 3");
    const retries = notes().filter((n) => n.content.startsWith("provider-error-retry:"));
    assert.equal(retries.length, 5);
    assert.ok(retries.every((n) => n.retryAt > 0 && n.outageSince > 0));
    assert.match(retries[0].content, /next attempt in .*of retry budget left/);
    assert.ok(notes().some((n) => n.content.startsWith("provider-recovered: after 5 retries")));
    assert.equal(session.outage, null);
  });

  it("gives up once the outage outlasts the retry budget", async () => {
    const { session, notes } = makeSession(
      Array.from({ length: 50 }, () => fail("502 Bad Gateway")),
      { retryBudgetMs: 60, providerErrorBackoffMs: 20 },
    );
    await session.start();
    const { stopReason } = await session.runPrompt("go");
    assert.equal(stopReason, "error");
    assert.ok(notes().some((n) => /giving up after \d+ retries/.test(n.content)));
    assert.ok(session.stats().providerErrorRetries < 10);
  });

  it("retries rate limits on the same budget", async () => {
    const { session } = makeSession([fail("HTTP 429 Too Many Requests"), fail("HTTP 429 Too Many Requests"), plan()]);
    await session.start();
    assert.equal((await session.runPrompt("go")).error, null);
    assert.equal(session.stats().rateLimitRetries, 2);
  });

  it("compacts once for an overflow error, then treats a repeat as an outage", async () => {
    const tooLarge =
      "400: Upstream request failed: [unsupported_request] This text request is too large for the model's configured input limit.";
    const { session } = makeSession([fail(tooLarge), fail(tooLarge), fail(tooLarge), plan()]);
    await session.start();
    assert.equal((await session.runPrompt("go")).error, null);
    assert.equal(session.takeHandoff()?.kind, "proposal");
    const stats = session.stats();
    assert.equal(stats.contextOverflowRetries, 1, "only one compaction");
    assert.equal(stats.providerErrorRetries, 2, "the repeats were waited out");
  });
});
