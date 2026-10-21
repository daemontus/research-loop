/**
 * Broker: the control plane's runtime around the protocol engine.
 *
 * - holds per-role inboxes (long-poll friendly) for the two agent processes;
 * - feeds agent handoffs, installer acks and human input to the engine
 *   (engine.mjs) and executes the effects it returns: deliveries, run-folder
 *   records, the end of the run;
 * - appends every input to the control-plane log (`<run>/control/session.jsonl`),
 *   which `replay` turns back into the same run for --resume and --view.
 *
 * Both agent processes serve every session: each envelope carries the
 * `agentId` (session id) it belongs to, so a process keeps one conversation
 * per session.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { createEngine, ROOT_ID } from "./engine.mjs";
import { renderGoalList } from "./goal-store.mjs";
import { validateEnvelope } from "../agent/lib/protocol.mjs";

export const ROLES = ["researcher", "advisor"];

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The control-plane log of a run directory. */
export function sessionLogPath(runDir) {
  return path.join(runDir, "control", "session.jsonl");
}

/**
 * @param {object} opts
 * @param {string} opts.task
 * @param {string} opts.runDir run folder (control log and records live here)
 * @param {string} opts.sessionId
 * @param {string} [opts.initialNote]
 * @param {boolean} [opts.skipSkills]
 * @param {string[]} [opts.preinstalledSkills]
 * @param {number|null} [opts.maxSubagentDepth]
 * @param {number} [opts.maxPlanChanges]
 * @param {number} [opts.maxSubagentRejections]
 * @param {number} [opts.maxHandoffs] 0 = unlimited (accepted handoffs in the run)
 * @param {number} [opts.maxRejections] consecutive invalid handoffs before aborting
 * @param {object[]} [opts.replayEntries] control-log entries to rebuild the run from
 * @param {string|null} [opts.expectedCodeHash] agent-code fingerprint of this checkout;
 *   agents reporting another one (a stale image) are refused
 * @param {boolean} [opts.allowStaleImage] accept them anyway, with a warning
 * @param {string|null} [opts.image] Docker image name, for the refusal message
 */
export function createBroker(opts) {
  const events = new EventEmitter();
  const runDir = opts.runDir;
  const controlLog = sessionLogPath(runDir);
  const engine = createEngine({
    task: opts.task || "",
    initialNote: opts.initialNote || "",
    skipSkills: Boolean(opts.skipSkills),
    preinstalledSkills: opts.preinstalledSkills || [],
    maxSubagentDepth: opts.maxSubagentDepth ?? null,
    maxPlanChanges: opts.maxPlanChanges || 0,
    maxSubagentRejections: opts.maxSubagentRejections || 0,
  });
  const maxHandoffs = opts.maxHandoffs || 0;
  const maxRejections = opts.maxRejections ?? 6;
  const queues = new Map(ROLES.map((r) => [r, []]));
  const waiters = new Map(ROLES.map((r) => [r, []]));
  const registered = new Map(ROLES.map((r) => [r, null]));
  let seq = 0;
  let closed = false;
  let rejections = 0;

  if (opts.replayEntries?.length) engine.replay(opts.replayEntries);

  function logSession(kind, payload = {}) {
    // Reserved keys win so a payload field can never change the event type.
    const entry = { ...payload, ts: payload.ts ?? Date.now(), agent: "control", kind, sessionId: opts.sessionId };
    try {
      fs.mkdirSync(path.dirname(controlLog), { recursive: true });
      fs.appendFileSync(controlLog, JSON.stringify(entry) + "\n");
    } catch {
      // best effort
    }
    events.emit("log", entry);
    return entry;
  }

  // ---- run-folder records -------------------------------------------------

  function write(rel, content) {
    try {
      const file = path.join(runDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    } catch {
      // best effort: records are for humans, the control log is authoritative
    }
  }

  function writeGoalsMd() {
    const snap = engine.snapshot();
    const lines = [
      "# Goals",
      "",
      `Run ${opts.sessionId}: ${snap.state}${snap.terminalReason ? ` (${snap.terminalReason})` : ""}`,
      "",
      "`[ ]` planned, `[~]` in progress, `[x]` done, `[-]` aborted",
      "",
      engine.renderGoalTree(),
      "",
    ];
    for (const g of engine.goalTree()) {
      lines.push("---", "", engine.goalDetail(g.id), "");
    }
    write("goals.md", lines.join("\n"));
  }

  function writeSessionRecord(sessionSnap) {
    const info = engine.sessionInfo(sessionSnap.id);
    if (!info || info.id === ROOT_ID) return;
    const dir = path.join("agents", info.id);
    write(path.join(dir, "agent.json"), JSON.stringify({ ...sessionSnap, instructions: info.instructions, conditions: info.conditions }, null, 2));
    if (info.brief) write(path.join(dir, "brief.md"), info.brief + "\n");
    if (info.outcome) {
      if (info.outcome.report) write(path.join(dir, "report.md"), info.outcome.report + "\n");
      if (info.outcome.notes) write(path.join(dir, "notes.md"), info.outcome.notes + "\n");
    }
  }

  // ---- effects ------------------------------------------------------------

  function enqueue(role, envelope) {
    const entry = { seq: ++seq, envelope };
    queues.get(role).push(entry);
    logSession("deliver", { to: role, agentId: envelope.agentId, deliverKind: envelope.kind, goalId: envelope.goalId ?? null });
    const waiting = waiters.get(role);
    while (waiting.length) {
      const waiter = waiting.shift();
      clearTimeout(waiter.timer);
      const q = queues.get(role);
      waiter.resolve({
        cursor: q.length ? q[q.length - 1].seq : waiter.cursor,
        messages: q.filter((m) => m.seq > waiter.cursor).map((m) => m.envelope),
      });
    }
    events.emit("deliver", { role, envelope });
  }

  function broadcast(kind, text) {
    for (const role of ROLES) enqueue(role, { role: "control", kind, text, payload: {}, ts: Date.now(), agentId: ROOT_ID });
  }

  function apply(result) {
    let changed = false;
    for (const e of result.effects || []) {
      switch (e.type) {
        case "deliver":
          enqueue(e.role, e.envelope);
          break;
        case "plan_version": {
          const dir = path.join("plans", e.owner);
          write(path.join(dir, `v${e.version}.json`), JSON.stringify(e.goals, null, 2));
          write(
            path.join(dir, `v${e.version}.md`),
            [`# Plan of ${e.owner}, version ${e.version}`, "", renderGoalList(e.goals), "", ...e.goals.map((g) => `## ${g.id} — ${g.title}\n\n${g.description}\n\nAcceptance:\n${g.acceptance.map((a) => `- ${a}`).join("\n")}\n`)].join("\n"),
          );
          logSession("plan_version", { agentId: e.owner, owner: e.owner, version: e.version, goals: e.goals.map((g) => ({ id: g.id, title: g.title, status: g.status })) });
          changed = true;
          break;
        }
        case "session_started":
          logSession("session_started", { agentId: e.session.id, session: e.session, info: engine.sessionInfo(e.session.id) });
          writeSessionRecord(e.session);
          changed = true;
          break;
        case "session_ended":
          logSession("session_ended", { agentId: e.session.id, session: e.session, goal: e.goal || null });
          writeSessionRecord(e.session);
          changed = true;
          break;
        case "skills":
          write("skills.json", JSON.stringify(e.record, null, 2));
          break;
        case "awaiting_human":
          logSession("awaiting_human", { request: e.request, agentId: ROOT_ID });
          break;
        case "terminal":
          logSession("terminal", { status: e.status, reason: e.reason });
          broadcast(e.status === "done" ? "session_done" : "abort", e.reason || e.status);
          closed = true;
          changed = true;
          break;
        default:
          changed = changed || e.type === "goals_changed";
      }
    }
    if (changed) writeGoalsMd();
    events.emit("state", snapshot());
  }

  function correction(role, agentId, error) {
    rejections += 1;
    logSession("reject", { from: role, agentId, error, rejections });
    if (maxRejections > 0 && rejections >= maxRejections) {
      abort(`too many consecutive invalid handoffs (${rejections}); last error: ${error}`);
      return;
    }
    apply(engine.correction(role, agentId, error));
  }

  // ---- inputs -------------------------------------------------------------

  function start() {
    logSession("start", { task: opts.task, initialNote: opts.initialNote || "", skipSkills: Boolean(opts.skipSkills) });
    apply(engine.start());
  }

  /**
   * Resume a replayed run: the acting agent gets a re-orientation prompt and
   * every other live conversation is marked lost.
   */
  function resume(extraText = "") {
    if (closed) return { ok: false, error: "session closed" };
    logSession("resume", { agentId: engine.activeId() });
    const r = engine.resume(extraText);
    apply(r);
    return { ok: r.ok, error: r.error, agentId: engine.activeId(), expecting: engine.expectedActor() };
  }

  /**
   * An agent process sent an envelope (a control tool, or an installer ack).
   * @returns {{ ok: boolean, error?: string, wait?: boolean, state: string }}
   */
  function receiveAgentEnvelope(role, envelope) {
    const state = () => engine.snapshot().activeState;
    if (closed) return { ok: false, error: "session closed", state: state() };
    if (!ROLES.includes(role) || !envelope || envelope.role !== role) {
      return { ok: false, error: "envelope role mismatch", state: state() };
    }
    const valid = validateEnvelope(envelope);
    const agentId = envelope.agentId || ROOT_ID;
    if (!valid.ok) {
      correction(role, agentId, valid.error);
      return { ok: false, error: valid.error, state: state() };
    }
    if (envelope.kind === "skills_installed") {
      const r = engine.skillsInstalled(role, envelope.payload || {});
      if (!r.ok) return { ok: false, error: r.error, wait: true, state: state() };
      logSession("skills_installed", { from: role, payload: envelope.payload || {} });
      apply(r);
      return { ok: true, state: state() };
    }
    const r = engine.handoff(role, agentId, envelope);
    if (!r.ok) {
      if (r.wait) {
        // Not this agent's turn (e.g. a duplicate after a lost response): it
        // just waits for its next message; a correction would make it act.
        logSession("reject", { from: role, agentId, error: r.error, outOfTurn: true, handoffKind: envelope.kind });
        events.emit("state", snapshot());
        return { ok: false, error: r.error, wait: true, state: state() };
      }
      correction(role, agentId, r.error);
      return { ok: false, error: r.error, state: state() };
    }
    rejections = 0;
    logSession("handoff", {
      from: role,
      agentId,
      handoffKind: envelope.kind,
      goalId: envelope.goalId ?? null,
      text: envelope.text || "",
      payload: envelope.payload || {},
    });
    apply(r);
    if (maxHandoffs > 0 && engine.snapshot().handoffs >= maxHandoffs && !closed) {
      abort(`max handoffs reached (${maxHandoffs})`);
    }
    return { ok: true, state: state() };
  }

  function humanDecision(decision) {
    if (closed) return { ok: false, error: "session closed", state: engine.snapshot().state };
    const r = engine.humanDecision({ action: decision?.action, text: decision?.text || "" });
    if (!r.ok) return { ok: false, error: r.error, state: engine.snapshot().state };
    logSession("human_decision", { action: decision.action, text: decision.text || "", agentId: ROOT_ID });
    apply(r);
    return { ok: true, state: engine.snapshot().state };
  }

  /** A human note for `target` of session `agentId` (default: the active one). */
  function humanMessage(target, text, _payload = {}, agentId = null) {
    if (closed) return { ok: false, error: "session closed" };
    const r = engine.humanMessage(target, text, agentId);
    if (!r.ok) return { ok: false, error: r.error };
    // Deferred notes are replayed too (they wait inside the engine).
    logSession("human_message", { to: target, agentId: agentId || engine.activeId(), text, deferred: Boolean(r.deferred) });
    apply(r);
    return { ok: true, deferred: Boolean(r.deferred), deferredUntil: r.deferredUntil };
  }

  function abort(reason) {
    if (closed) return;
    // Agents may exit non-zero while being stopped after approval; a finished
    // run stays finished.
    if (engine.run().status === "done") return complete();
    const r = engine.abortRun(reason);
    logSession("abort", { reason });
    if (r.ok) apply(r);
    else {
      closed = true;
      broadcast("abort", reason);
    }
  }

  function complete() {
    if (closed) return;
    closed = true;
    logSession("closed", { reason: engine.run().terminalReason || "done" });
    events.emit("state", snapshot());
  }

  function poll(role, cursor, waitMs = 25000) {
    if (!ROLES.includes(role)) return Promise.reject(new Error(`unknown role: ${role}`));
    const q = queues.get(role);
    const pending = q.filter((m) => m.seq > cursor);
    if (pending.length) return Promise.resolve({ cursor: q[q.length - 1].seq, messages: pending.map((m) => m.envelope) });
    return new Promise((resolve) => {
      const waiter = { role, cursor, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const list = waiters.get(role);
        const idx = list.indexOf(waiter);
        if (idx >= 0) list.splice(idx, 1);
        resolve({ cursor, messages: [], timedOut: true });
      }, Math.max(0, waitMs));
      waiters.get(role).push(waiter);
    });
  }

  function snapshot() {
    return {
      sessionId: opts.sessionId,
      ...engine.snapshot(),
      registered: Object.fromEntries([...registered.entries()].map(([r, v]) => [r, Boolean(v)])),
      closed,
    };
  }

  return {
    events,
    engine,
    start,
    resume,
    receiveAgentEnvelope,
    humanDecision,
    humanMessage,
    abort,
    complete,
    poll,
    snapshot,
    sessionInfo: (id) => engine.sessionInfo(id),
    goalTree: () => ({ goals: engine.goalTree(), markdown: engine.renderGoalTree() }),
    goalDetail: (id) => engine.goalDetail(id),
    /**
     * An agent process came online. Its agent-code fingerprint must match this
     * checkout's: an image built from other code speaks another protocol.
     * @returns {{ ok: boolean, error?: string, registered?: object }}
     */
    register(role, codeHash = null) {
      if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
      const expected = opts.expectedCodeHash || null;
      if (expected && codeHash !== expected) {
        const error =
          `the ${role} agent's code (${codeHash || "unknown: built before this check existed"}) differs from this ` +
          `checkout's (${expected})${opts.image ? `, so the image ${opts.image} is out of date` : ""}. ` +
          `Rebuild it (docker build -f Dockerfile.agent -t ${opts.image || "<image>"} .) or pass --image; ` +
          "--allow-stale-image proceeds anyway";
        if (!opts.allowStaleImage) {
          logSession("register_refused", { from: role, codeHash, expectedCodeHash: expected, error });
          abort(`stale agent image: ${error}`);
          return { ok: false, error };
        }
        logSession("register_warning", { from: role, codeHash, expectedCodeHash: expected, error });
      }
      registered.set(role, Date.now());
      events.emit("state", snapshot());
      return { ok: true, registered: snapshot().registered };
    },
    /**
     * View-only (--view): nothing will act, so the run counts as closed. Replay
     * skips aborts (so --resume can continue an aborted run); a viewed run
     * shows how it actually ended.
     */
    freeze() {
      const terminal = [...(opts.replayEntries || [])].reverse().find((e) => e.kind === "terminal");
      if (terminal?.status === "aborted" && engine.isRunning()) engine.abortRun(terminal.reason || "aborted", terminal.ts);
      closed = true;
      events.emit("state", snapshot());
    },
    isClosed: () => closed,
  };
}

/** Control-log entries of a run, for --resume / --view. */
export function readSessionLog(runDir) {
  return readJsonl(sessionLogPath(runDir));
}
