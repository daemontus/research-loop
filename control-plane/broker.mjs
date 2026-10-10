/**
 * In-memory broker + session controller for the two agents.
 *
 * Holds per-role inboxes (long-poll friendly), applies the state machine to
 * incoming handoffs, routes deliveries, and records session events. The HTTP
 * server in server.mjs is a thin wrapper over this.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  applyEnvelope,
  applyHumanDecision,
  applyStart,
  createSessionState,
  markAborted,
  STATES,
} from "./state-machine.mjs";
import { validateEnvelope } from "../agent/lib/protocol.mjs";

export const ROLES = ["researcher", "advisor"];

/** The role expected to act in a given state, or null (human/terminal). */
export function expectedRoleForState(stateValue) {
  switch (stateValue) {
    case STATES.INIT:
    case STATES.RESEARCHER_SKILLS:
    case STATES.RESEARCHER_INSTALL_SKILLS:
    case STATES.RESEARCHER_DECOMPOSE:
    case STATES.RESEARCHER_EXECUTE:
      return "researcher";
    case STATES.ADVISOR_REVIEW_SKILLS:
    case STATES.ADVISOR_REVIEW_PLAN:
    case STATES.ADVISOR_REVIEW_RESULT:
    case STATES.ADVISOR_REVIEW_TASK:
      return "advisor";
    default:
      return null;
  }
}

/**
 * Replay a session.jsonl file back into a control-plane state so a run can be
 * resumed from where it left off (containers are fresh; GOALS.md/artifacts and
 * this log are what persist between processes).
 *
 * Entries of kind "start"/"handoff"/"human_decision" drive the state machine;
 * everything else (deliveries, rejects, aborts, terminals) records the run but
 * does not change state. The terminal "abort" entry is deliberately not applied
 * so the returned state is where the agents should continue.
 *
 * @param {string} transcriptDir
 * @returns {{ state: object, researcherSteps: number, skipSkills: boolean, started: boolean }}
 */
export function replaySessionLog(transcriptDir) {
  const file = path.join(transcriptDir, "session.jsonl");
  let state = createSessionState();
  let started = false;
  let skipSkills = false;
  let researcherSteps = 0;
  let entries = [];
  try {
    entries = fs
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
    // no session log yet
  }
  for (const e of entries) {
    if (e.kind === "start") {
      skipSkills = Boolean(e.skipSkills);
      const r = applyStart(state, { skipSkills });
      state = r.state;
      started = true;
      // Preserve the original session start time for duration accounting.
      if (typeof e.ts === "number" && e.ts > 0) state.startedAt = e.ts;
      continue;
    }
    if (!started) continue;
    if (e.kind === "handoff") {
      const envelope = {
        role: e.from,
        kind: e.handoffKind,
        goalId: e.goalId ?? null,
        text: e.text ?? "",
        payload: e.payload ?? {},
        ts: e.ts ?? Date.now(),
      };
      const r = applyEnvelope(state, envelope);
      if (!r.error) {
        state = r.state;
        if (e.from === "researcher" && (e.handoffKind === "proposal" || e.handoffKind === "result")) {
          researcherSteps += 1;
        }
      }
      continue;
    }
    if (e.kind === "human_decision") {
      const r = applyHumanDecision(state, { action: e.action, text: e.text, target: e.target });
      if (!r.error) {
        state = r.state;
        const last = state.humanDecisions[state.humanDecisions.length - 1];
        if (last && typeof e.ts === "number" && e.ts > 0) last.ts = e.ts;
      }
      continue;
    }
  }
  return { state, researcherSteps, skipSkills, started };
}

export function createBroker({
  token,
  task,
  transcriptDir,
  sessionId,
  maxHandoffs = 0,
  maxRejections = 6,
  initialNote = "",
  skipSkills = false,
  installedSkillsPath = null,
  initialState = null,
  initialResearcherSteps = 0,
}) {
  const events = new EventEmitter();
  const roles = ROLES;
  const queues = new Map(roles.map((r) => [r, []]));
  const waiters = new Map(roles.map((r) => [r, []]));
  const registered = new Map(roles.map((r) => [r, null]));
  const deferredHuman = new Map(roles.map((r) => [r, []]));
  let seq = 0;
  let state = initialState ? { ...initialState } : createSessionState();
  let closed = false;
  let rejections = 0;
  let researcherSteps = initialResearcherSteps || 0;

  /** The role that must act next, or null (human/terminal). */
  function expectedRole(...a) {
    return expectedRoleForState(...a);
  }

  const sessionLogPath = path.join(transcriptDir, "session.jsonl");
  function logSession(kind, payload = {}) {
    // Reserved keys win so a payload field can never change the event type.
    const entry = { ...payload, ts: Date.now(), agent: "control", kind, sessionId };
    try {
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.appendFileSync(sessionLogPath, JSON.stringify(entry) + "\n");
    } catch {
      // best effort
    }
    events.emit("log", entry);
  }

  function deliver(role, envelope) {
    // Merge any human notes that were deferred until this role's turn into the
    // handoff that just triggered it (single prompt, no out-of-turn action).
    const deferred = deferredHuman.get(role);
    if (envelope.role !== "control" && deferred?.length) {
      const notes = deferred.splice(0);
      const humanText = notes.map((n) => `[human note] ${n.text}`).join("\n");
      envelope = {
        ...envelope,
        text: `${humanText}\n\n${envelope.text || ""}`.trim(),
      };
      logSession("human_message_merged", { to: role, count: notes.length });
    }
    const entry = { seq: ++seq, envelope };
    queues.get(role).push(entry);
    logSession("deliver", { to: role, deliverKind: envelope.kind, goalId: envelope.goalId ?? null });
    const waiting = waiters.get(role);
    while (waiting.length) {
      const waiter = waiting.shift();
      clearTimeout(waiter.timer);
      const q = queues.get(role);
      const pending = q.filter((m) => m.seq > waiter.cursor);
      waiter.resolve({
        cursor: q.length ? q[q.length - 1].seq : waiter.cursor,
        messages: pending.map((m) => m.envelope),
      });
    }
    events.emit("deliver", { role, envelope });
  }

  function broadcastControl(kind, text, extra = {}) {
    for (const role of roles) {
      deliver(role, { role: "control", kind, text, payload: {}, ts: Date.now(), ...extra });
    }
  }

  function acceptDeliveries(result) {
    for (const d of result.deliveries || []) {
      deliver(d.to, d.envelope);
    }
  }

  function finishIfTerminal(result) {
    if (result.terminal === "done") {
      logSession("terminal", { reason: state.terminalReason });
      broadcastControl("session_done", state.terminalReason || "done");
    } else if (result.terminal === "aborted") {
      logSession("terminal", { reason: state.terminalReason });
      broadcastControl("abort", state.terminalReason || "aborted");
    }
  }

  function start() {
    const r = applyStart(state, { skipSkills });
    state = r.state;
    logSession("start", { task, initialNote, skipSkills });
    const skillsStep = skipSkills
      ? [
          "Begin by inspecting /sandbox (including provided resources and any skills under",
          "/sandbox/skills — you MUST use installed skills where relevant), then decompose the",
          "task into high-level goals and write GOALS.md. Propose the first goal with",
          "submit_plan. Do not execute before the advisor approves.",
        ]
      : [
          "Begin with the SKILLS step (required before any planning):",
          "  1. Inspect /sandbox and /config/skills for existing skills.",
          "  2. Search skills.sh for reusable skills relevant to this task, e.g.",
          "     `npx skills find <query>` (and check skills.sh for audits/popularity).",
          "  3. Call propose_skills with the relevant set (or noneNeeded with justification).",
          "The advisor must approve the set. Only then install the approved skills with the",
          "install_skill tool, call confirm_skills_installed, and proceed to plan. Do NOT submit",
          "a task plan before the skills step is complete.",
        ];
    deliver("researcher", {
      role: "control",
      kind: "start",
      text: [
        "A new research session is starting.",
        "",
        "## Broad research task",
        task,
        ...(initialNote ? ["", "## Initial resources", initialNote] : []),
        "",
        ...skillsStep,
      ].join("\n"),
      payload: {},
      ts: Date.now(),
    });
  }

  /**
   * Resume an interrupted session. The broker state was already restored by
   * creoring the broker with `initialState`; this delivers the resume prompt
   * to whichever role is expected to act next (no state transition, unlike
   * start()).
   *
   * @param {string} contextText full prompt text for the acting agent
   * @param {string} [initialNote]
   */
  function resume(contextText, initialNote = "") {
    if (closed) return { ok: false, error: "session closed" };
    logSession("resume", { task, initialNote });
    const expected = expectedRole(state.state);
    if (expected) {
      deliver(expected, {
        role: "control",
        kind: "start",
        text: contextText,
        payload: {},
        ts: Date.now(),
      });
    }
    events.emit("state", snapshot());
    return { ok: true, state: state.state, expecting: expected };
  }

  /**
   * Handle an agent handoff envelope.
   * @returns {{ok: boolean, error?: string, state: string}}
   */
  function receiveAgentEnvelope(role, envelope) {
    if (closed) return { ok: false, error: "session closed", state: state.state };
    if (!envelope || envelope.role !== role) {
      return { ok: false, error: "envelope role mismatch", state: state.state };
    }
    const valid = validateEnvelope(envelope);
    if (!valid.ok) {
      deliverCorrection(role, valid.error);
      return { ok: false, error: valid.error, state: state.state };
    }
    if (state.state === STATES.RESEARCHER_INSTALL_SKILLS && envelope.kind === "skills_ready") {
      const missing = missingInstalledSkills(envelope.payload);
      if (missing.length) {
        const error = `confirm_skills_installed lists skills not found under /sandbox/skills: ${missing.join(", ")}. Install them with install_skill first.`;
        deliverCorrection(role, error);
        return { ok: false, error, state: state.state };
      }
    }
    logSession("handoff", {
      from: role,
      handoffKind: envelope.kind,
      goalId: envelope.goalId ?? null,
      text: envelope.text || "",
      payload: envelope.payload || {},
    });
    const result = applyEnvelope(state, envelope);
    if (result.error) {
      deliverCorrection(role, result.error);
      return { ok: false, error: result.error, state: state.state };
    }
    state = result.state;
    if (role === "researcher" && (envelope.kind === "proposal" || envelope.kind === "result")) {
      researcherSteps += 1;
    }
    acceptDeliveries(result);
    finishIfTerminal(result);
    if (maxHandoffs > 0 && researcherSteps >= maxHandoffs && state.state !== STATES.DONE) {
      abort(`max researcher steps reached (${maxHandoffs})`);
    }
    events.emit("state", snapshot());
    return { ok: true, state: state.state };
  }

  function expectedForState(stateValue) {
    switch (stateValue) {
      case STATES.RESEARCHER_SKILLS:
        return { role: "researcher", actions: ["propose_skills"] };
      case STATES.RESEARCHER_INSTALL_SKILLS:
        return { role: "researcher", actions: ["confirm_skills_installed"] };
      case STATES.ADVISOR_REVIEW_SKILLS:
        return { role: "advisor", actions: ["approve_skills", "request_skill_changes"] };
      case STATES.RESEARCHER_DECOMPOSE:
        return { role: "researcher", actions: ["submit_plan"] };
      case STATES.RESEARCHER_EXECUTE:
        return { role: "researcher", actions: ["submit_result", "submit_plan", "request_task_completion"] };
      case STATES.ADVISOR_REVIEW_PLAN:
        return { role: "advisor", actions: ["approve_plan", "request_plan_changes"] };
      case STATES.ADVISOR_REVIEW_RESULT:
        return { role: "advisor", actions: ["accept_result", "request_result_changes"] };
      case STATES.ADVISOR_REVIEW_TASK:
        return { role: "advisor", actions: ["accept_task_completion", "request_task_changes"] };
      default:
        return { role: null, actions: [] };
    }
  }

  /** Verify a skills_ready payload against the sandbox skills directory. */
  function missingInstalledSkills(payload) {
    if (!installedSkillsPath) return [];
    const installed = Array.isArray(payload?.installed) ? payload.installed : [];
    const missing = [];
    for (const entry of installed) {
      const name = String(entry?.name || "").trim();
      if (!name) continue;
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
      if (
        !fs.existsSync(path.join(installedSkillsPath, name)) &&
        !fs.existsSync(path.join(installedSkillsPath, safe))
      ) {
        missing.push(name);
      }
    }
    return missing;
  }

  function deliverCorrection(role, error) {
    rejections += 1;
    logSession("reject", { from: role, error, rejections });
    if (maxRejections > 0 && rejections >= maxRejections) {
      deliver(role, {
        role: "control",
        kind: "prompt",
        text: `Too many invalid handoffs (${rejections}); aborting. Last error: ${error}`,
        payload: {},
        ts: Date.now(),
      });
      abort(`too many invalid handoffs (${rejections})`);
      return;
    }
    const expected = expectedForState(state.state);
    const actions = expected.actions.length
      ? expected.actions.map((a) => `\`${a}\``).join(", ")
      : "(none)";
    deliver(role, {
      role: "control",
      kind: "prompt",
      text: [
        `Your last handoff was rejected by the orchestrator: ${error}.`,
        "",
        `The session is currently in state ${state.state}.`,
        expected.role
          ? `The ${expected.role} is expected to call one of: ${actions}.`
          : `Expected control tools: ${actions}.`,
        "",
        "Re-read your role instructions and the current GOALS.md, then call the appropriate",
        "control tool now. (A result can only be submitted after a plan for that goal has been",
        "approved.)",
      ].join("\n"),
      payload: {},
      ts: Date.now(),
    });
  }

  function humanDecision(decision) {
    if (closed) return { ok: false, error: "session closed", state: state.state };
    logSession("human_decision", decision);
    const result = applyHumanDecision(state, decision);
    if (result.error) return { ok: false, error: result.error, state: state.state };
    state = result.state;
    acceptDeliveries(result);
    finishIfTerminal(result);
    events.emit("state", snapshot());
    return { ok: true, state: state.state, terminal: result.terminal || null };
  }

  function humanMessage(target, text, payload = {}) {
    if (closed) return { ok: false, error: "session closed" };
    if (!roles.includes(target)) return { ok: false, error: `invalid target: ${target}` };
    const expected = expectedRole(state.state);
    if (expected === null) {
      return { ok: false, error: "no agent is expected to act right now" };
    }
    if (expected !== target) {
      // Hold the note until it is this role's turn, then merge it into the
      // handoff that triggers them (avoids acting out of turn).
      deferredHuman.get(target).push({ text, payload });
      logSession("human_message_deferred", { to: target, expects: expected, text });
      events.emit("state", snapshot());
      return { ok: true, deferred: true, deferredUntil: expected };
    }
    logSession("human_message", { to: target, text });
    deliver(target, {
      role: "human",
      kind: "human_message",
      goalId: state.currentGoalId,
      text,
      payload,
      ts: Date.now(),
    });
    events.emit("state", snapshot());
    return { ok: true };
  }

  function abort(reason) {
    if (closed) return;
    closed = true;
    const result = markAborted(state, reason);
    state = result.state;
    logSession("abort", { reason });
    broadcastControl("abort", reason);
    events.emit("state", snapshot());
  }

  function complete() {
    if (closed) return;
    closed = true;
    logSession("closed", { reason: state.terminalReason || "done" });
    events.emit("state", snapshot());
  }

  function poll(role, cursor, waitMs = 25000) {
    if (!roles.includes(role)) return Promise.reject(new Error(`unknown role: ${role}`));
    const q = queues.get(role);
    const pending = q.filter((m) => m.seq > cursor);
    if (pending.length) {
      return Promise.resolve({
        cursor: q[q.length - 1].seq,
        messages: pending.map((m) => m.envelope),
      });
    }
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
      sessionId,
      state: state.state,
      currentGoalId: state.currentGoalId,
      handoffs: state.handoffs,
      researcherSteps,
      humanDecisions: state.humanDecisions,
      registered: Object.fromEntries([...registered.entries()].map(([r, v]) => [r, Boolean(v)])),
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      terminalReason: state.terminalReason,
      expecting: expectedRole(state.state),
    };
  }

  return {
    events,
    start,
    resume,
    receiveAgentEnvelope,
    humanDecision,
    humanMessage,
    abort,
    complete,
    poll,
    snapshot,
    register(role) {
      if (!roles.includes(role)) throw new Error(`unknown role: ${role}`);
      registered.set(role, Date.now());
      events.emit("state", snapshot());
      return { ok: true, registered: snapshot().registered };
    },
    /**
     * Restore a previously-replayed state (used by --view so a completed run
     * shows its final state without starting containers) and broadcast it.
     */
    seed(nextState) {
      state = { ...nextState };
      events.emit("state", snapshot());
      return snapshot();
    },
    isClosed: () => closed,
    get state() {
      return state;
    },
    set state(v) {
      state = v;
    },
  };
}
