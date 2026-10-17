/**
 * In-memory broker + session controller for the two agents.
 *
 * Holds per-role inboxes (long-poll friendly), applies the state machine to
 * incoming handoffs, routes deliveries, and records session events. The HTTP
 * server in server.mjs is a thin wrapper over this.
 *
 * Subagents: the broker keeps a tree of agent sessions (the human-supervised
 * "root" plus any subagents). Each has its own state machine; exactly one is
 * active at a time (a parent is paused in SUBAGENT_RUNNING while its child
 * works). Both roles of a subagent run inside the same researcher/advisor
 * processes as their parent; every envelope carries the `agentId` it belongs
 * to, so each process can keep a separate conversation per agent.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  applyEnvelope,
  applyHumanDecision,
  applyStart,
  applySubagentDone,
  createSessionState,
  markAborted,
  STATES,
} from "./state-machine.mjs";
import { ROOT_AGENT_ID, validateEnvelope } from "../agent/lib/protocol.mjs";

export const ROLES = ["researcher", "advisor"];

/** Largest report inlined into the parent's prompt; longer ones are truncated. */
const MAX_INLINE_REPORT_CHARS = 20000;

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
    case STATES.ADVISOR_REVIEW_SUBAGENT:
      return "advisor";
    default:
      return null;
  }
}

/** Sandbox-relative folder of a subagent (same path in every container). */
export function subagentDir(agentId) {
  return path.posix.join("agents", agentId);
}

/** Public (UI/agent-facing) metadata of a subagent record. */
function agentMeta(agent) {
  if (!agent || agent.id === ROOT_AGENT_ID) return null;
  return {
    id: agent.id,
    parentId: agent.parentId,
    depth: agent.depth,
    title: agent.title,
    goalId: agent.goalId ?? null,
    instructions: agent.instructions,
    conditions: agent.conditions || [],
    advisory: agent.advisory || [],
    createdAt: agent.createdAt,
  };
}

function newSubagentRecord(meta, ts = Date.now()) {
  const state = applyStart(createSessionState({ subagent: true })).state;
  state.startedAt = meta.createdAt || ts;
  return {
    id: meta.id,
    parentId: meta.parentId,
    depth: meta.depth,
    title: meta.title || meta.id,
    goalId: meta.goalId ?? null,
    instructions: meta.instructions || "",
    conditions: meta.conditions || [],
    advisory: meta.advisory || [],
    createdAt: meta.createdAt || ts,
    finishedAt: null,
    state,
    pendingProposal: null,
    snapshot: {},
  };
}

function readJsonl(file) {
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

function readSnapshotFile(agentsDir, agentId) {
  if (!agentsDir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(agentsDir, agentId, "goals-snapshot.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Replay a session.jsonl file back into a control-plane state so a run can be
 * resumed from where it left off (containers are fresh; GOALS.md/artifacts and
 * this log are what persist between processes).
 *
 * Entries of kind "start"/"handoff"/"human_decision" drive the state machine;
 * "subagent_start"/"subagent_done" rebuild the agent tree; everything else
 * (deliveries, rejects, aborts, terminals) records the run but does not change
 * state. The terminal "abort" entry is deliberately not applied so the
 * returned state is where the agents should continue.
 *
 * @param {string} transcriptDir
 * @param {{ agentsDir?: string }} [opts] where subagent snapshots live
 *   (default: `<run>/agents`, next to the transcripts directory)
 * @returns {{ state: object, researcherSteps: number, skipSkills: boolean, started: boolean,
 *   agents: object[], activeId: string }}
 */
export function replaySessionLog(transcriptDir, { agentsDir = null } = {}) {
  const snapDir = agentsDir || path.join(path.dirname(transcriptDir), "agents");
  let started = false;
  let skipSkills = false;
  let researcherSteps = 0;
  const root = { id: ROOT_AGENT_ID, parentId: null, depth: 0, state: createSessionState(), pendingProposal: null };
  const agents = new Map([[ROOT_AGENT_ID, root]]);
  let activeId = ROOT_AGENT_ID;
  const entries = readJsonl(path.join(transcriptDir, "session.jsonl"));
  for (const e of entries) {
    if (e.kind === "start") {
      skipSkills = Boolean(e.skipSkills);
      root.state = applyStart(root.state, { skipSkills }).state;
      started = true;
      // Preserve the original session start time for duration accounting.
      if (typeof e.ts === "number" && e.ts > 0) root.state.startedAt = e.ts;
      continue;
    }
    if (!started) continue;
    if (e.kind === "handoff") {
      const agent = agents.get(e.agentId || ROOT_AGENT_ID);
      if (!agent) continue;
      const envelope = {
        role: e.from,
        kind: e.handoffKind,
        goalId: e.goalId ?? null,
        text: e.text ?? "",
        payload: e.payload ?? {},
        ts: e.ts ?? Date.now(),
      };
      const r = applyEnvelope(agent.state, envelope);
      if (!r.error) {
        agent.state = r.state;
        if (e.from === "researcher" && (e.handoffKind === "proposal" || e.handoffKind === "result")) {
          researcherSteps += 1;
        }
        if (e.handoffKind === "subagent_proposal") agent.pendingProposal = envelope;
        if (e.handoffKind === "proposal") agent.lastPlanExecution = envelope.payload?.execution || null;
      }
      continue;
    }
    if (e.kind === "subagent_start" && e.meta?.id) {
      const child = newSubagentRecord(e.meta, e.ts);
      child.snapshot = readSnapshotFile(snapDir, child.id);
      agents.set(child.id, child);
      const parent = agents.get(child.parentId);
      if (parent) parent.pendingProposal = null;
      activeId = child.id;
      continue;
    }
    if (e.kind === "subagent_done" && e.agentId) {
      const child = agents.get(e.agentId);
      if (!child) continue;
      if (child.state.state !== STATES.DONE) {
        child.state = { ...child.state, state: STATES.DONE, terminalReason: "subagent completed" };
      }
      child.finishedAt = e.ts ?? Date.now();
      child.state.finishedAt = child.finishedAt;
      const parent = agents.get(child.parentId);
      if (parent) {
        const r = applySubagentDone(parent.state, { role: "control", kind: "prompt", text: "", payload: {} });
        if (!r.error) parent.state = r.state;
        activeId = parent.id;
      }
      continue;
    }
    if (e.kind === "human_decision") {
      const r = applyHumanDecision(root.state, { action: e.action, text: e.text, target: e.target });
      if (!r.error) {
        root.state = r.state;
        const last = root.state.humanDecisions[root.state.humanDecisions.length - 1];
        if (last && typeof e.ts === "number" && e.ts > 0) last.ts = e.ts;
      }
      continue;
    }
  }
  return {
    state: root.state,
    researcherSteps,
    skipSkills,
    started,
    agents: [...agents.values()].filter((a) => a.id !== ROOT_AGENT_ID),
    activeId,
    rootPendingProposal: root.pendingProposal,
    rootLastPlanExecution: root.lastPlanExecution || null,
  };
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
  // Subagents (all optional): restored tree, host path of the researcher's
  // sandbox (for GOALS.md/REPORT.md checks), where subagent records are kept,
  // and the recursion limit (null/undefined = unlimited, 0 = disabled).
  initialAgents = null,
  initialActiveId = null,
  initialRootPendingProposal = null,
  initialRootLastPlanExecution = null,
  researcherSandbox = null,
  agentsDir = null,
  maxSubagentDepth = null,
  // "encouraged" = supervisor mode for the main researcher (see prompts.mjs).
  delegation = "optional",
}) {
  const events = new EventEmitter();
  const roles = ROLES;
  const queues = new Map(roles.map((r) => [r, []]));
  const waiters = new Map(roles.map((r) => [r, []]));
  const registered = new Map(roles.map((r) => [r, null]));
  // Notes held until an agent/role pair is expected to act, keyed "agentId:role".
  const deferredNotes = new Map();
  // Agent/role pairs whose conversation was lost (resume) and has not been
  // re-primed yet; their next delivery carries a re-orientation note.
  const staleContexts = new Set();
  let seq = 0;
  let closed = false;
  let rejections = 0;
  let researcherSteps = initialResearcherSteps || 0;
  const recordsDir = agentsDir || path.join(path.dirname(transcriptDir), "agents");

  /** @type {Map<string, object>} */
  const agents = new Map();
  agents.set(ROOT_AGENT_ID, {
    id: ROOT_AGENT_ID,
    parentId: null,
    depth: 0,
    title: "Main task",
    createdAt: null,
    finishedAt: null,
    state: initialState ? { ...initialState } : createSessionState(),
    pendingProposal: initialRootPendingProposal || null,
    lastPlanExecution: initialRootLastPlanExecution || null,
    snapshot: {},
  });
  for (const a of initialAgents || []) agents.set(a.id, { ...a });
  let activeId = initialActiveId && agents.has(initialActiveId) ? initialActiveId : ROOT_AGENT_ID;
  let subagentSeq = 0;
  for (const id of agents.keys()) {
    const n = Number(/^S(\d+)$/.exec(id)?.[1]);
    if (n > subagentSeq) subagentSeq = n;
  }

  const rootAgent = () => agents.get(ROOT_AGENT_ID);
  const activeAgent = () => agents.get(activeId);

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

  const noteKey = (agentId, role) => `${agentId}:${role}`;
  function deferNote(agentId, role, text) {
    const key = noteKey(agentId, role);
    if (!deferredNotes.has(key)) deferredNotes.set(key, []);
    deferredNotes.get(key).push(text);
  }

  const NO_MERGE_KINDS = new Set(["session_done", "abort", "agent_done"]);

  function deliver(role, envelope, agentId = activeId) {
    const agent = agents.get(agentId);
    // Merge any notes that were deferred until this agent/role's turn into the
    // handoff that just triggered it (single prompt, no out-of-turn action).
    const key = noteKey(agentId, role);
    const deferred = deferredNotes.get(key);
    const mergeable = !NO_MERGE_KINDS.has(envelope.kind);
    // Notes ride on real handoffs (and on a subagent's report), never on
    // orchestrator corrections.
    const carriesNotes = envelope.role !== "control" || Boolean(envelope.payload?.subagentId);
    if (mergeable && carriesNotes && deferred?.length) {
      const notes = deferred.splice(0);
      envelope = {
        ...envelope,
        text: `${notes.join("\n\n")}\n\n${envelope.text || ""}`.trim(),
      };
      logSession("human_message_merged", { to: role, agentId, count: notes.length });
    }
    if (mergeable && envelope.kind !== "start" && staleContexts.has(key)) {
      staleContexts.delete(key);
      envelope = {
        ...envelope,
        text: [
          "[note from the orchestrator] This session was RESUMED in a fresh container while you",
          "were waiting, so your earlier conversation is gone. Re-read your GOALS.md, notes, and",
          "artifacts in the sandbox to re-orient yourself (installed tools may need reinstalling),",
          "then handle the message below and continue the task (do not restart it).",
          "",
          envelope.text || "",
        ].join("\n").trim(),
      };
    }
    envelope = { ...envelope, agentId };
    const meta = agentMeta(agent);
    if (meta) envelope.agent = meta;
    const entry = { seq: ++seq, envelope };
    queues.get(role).push(entry);
    logSession("deliver", { to: role, agentId, deliverKind: envelope.kind, goalId: envelope.goalId ?? null });
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
      deliver(role, { role: "control", kind, text, payload: {}, ts: Date.now(), ...extra }, ROOT_AGENT_ID);
    }
  }

  function acceptDeliveries(result, agentId) {
    for (const d of result.deliveries || []) {
      const envelope = d.to === "researcher" ? withDelegationHint(agentId, d.envelope) : d.envelope;
      deliver(d.to, envelope, agentId);
    }
  }

  function canSpawn(agent) {
    return maxSubagentDepth == null || agent.depth + 1 <= maxSubagentDepth;
  }

  // Handoffs after which the researcher picks its next goal.
  const NEXT_GOAL_KINDS = new Set(["result_accepted", "task_changes", "human_message"]);

  /**
   * Remind a researcher that may delegate about it at decision points, so the
   * option stays near the end of its (long) context: right after a plan marked
   * `execution: "subagent"` is approved, and whenever it picks the next goal.
   */
  function withDelegationHint(agentId, envelope) {
    const agent = agents.get(agentId);
    if (!agent || !canSpawn(agent)) return envelope;
    const supervisor = agentId === ROOT_AGENT_ID && delegation === "encouraged";
    let hint = null;
    if (envelope.kind === "plan_approved" && agent.lastPlanExecution === "subagent") {
      const goal = envelope.goalId || agent.state.currentGoalId;
      hint =
        `[orchestrator] Your approved plan${goal ? ` for ${goal}` : ""} has execution: "subagent". ` +
        `Delegate it now with propose_subagent${goal ? ` (goalId ${goal})` : ""}, with complete, ` +
        "self-contained instructions; do not start the work yourself.";
    } else if (NEXT_GOAL_KINDS.has(envelope.kind) || envelope.payload?.subagentId) {
      hint =
        "[orchestrator] Before you plan the next goal, decide its `execution`: " +
        (supervisor
          ? "you are the supervisor, so delegate it to a subagent unless it is small, tightly coupled, or integration work."
          : "delegate it to a subagent if it is substantial and self-contained, to keep your context focused.");
    }
    if (!hint) return envelope;
    return { ...envelope, text: `${envelope.text || ""}\n\n${hint}`.trim() };
  }

  function finishIfTerminal(result) {
    const root = rootAgent().state;
    if (result.terminal === "done") {
      logSession("terminal", { reason: root.terminalReason });
      broadcastControl("session_done", root.terminalReason || "done");
    } else if (result.terminal === "aborted") {
      logSession("terminal", { reason: root.terminalReason });
      broadcastControl("abort", root.terminalReason || "aborted");
    }
  }

  function start() {
    const root = rootAgent();
    root.state = applyStart(root.state, { skipSkills }).state;
    logSession("start", { task, initialNote, skipSkills, agentId: ROOT_AGENT_ID });
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
    deliver(
      "researcher",
      {
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
      },
      ROOT_AGENT_ID,
    );
  }

  /**
   * Resume an interrupted session. The broker state was already restored by
   * creating the broker with `initialState`/`initialAgents`; this delivers the
   * resume prompt to whichever agent/role is expected to act next (no state
   * transition, unlike start()). Every other live conversation is marked
   * stale so its next prompt says the context was lost.
   *
   * @param {string} contextText full prompt text for the acting agent
   * @param {string} [initialNote]
   */
  function resume(contextText, initialNote = "") {
    if (closed) return { ok: false, error: "session closed" };
    logSession("resume", { task, initialNote, agentId: activeId });
    const expected = expectedRole(activeAgent().state.state);
    for (const agent of agents.values()) {
      if (agent.state.state === STATES.DONE || agent.state.state === STATES.ABORTED) continue;
      for (const role of roles) staleContexts.add(noteKey(agent.id, role));
    }
    if (expected) {
      staleContexts.delete(noteKey(activeId, expected));
      deliver(expected, {
        role: "control",
        kind: "start",
        text: contextText,
        payload: {},
        ts: Date.now(),
      });
    }
    events.emit("state", snapshot());
    return { ok: true, state: activeAgent().state.state, expecting: expected, agentId: activeId };
  }

  // ---- subagents -----------------------------------------------------------

  function sandboxFile(rel) {
    return researcherSandbox ? path.join(researcherSandbox, ...rel.split("/")) : null;
  }

  /**
   * Contents of every GOALS.md the new subagent must not touch: the root's and
   * every other known agent's. Files that do not exist yet are not protected.
   */
  function snapshotProtectedGoals(excludeId) {
    const snap = {};
    if (!researcherSandbox) return snap;
    const rels = ["GOALS.md"];
    for (const id of agents.keys()) {
      if (id !== ROOT_AGENT_ID && id !== excludeId) rels.push(`${subagentDir(id)}/GOALS.md`);
    }
    for (const rel of rels) {
      try {
        snap[rel] = fs.readFileSync(sandboxFile(rel), "utf8");
      } catch {
        // not written (yet): nothing to protect
      }
    }
    return snap;
  }

  function writeRecord(agent, extra = {}) {
    try {
      const dir = path.join(recordsDir, agent.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "agent.json"),
        JSON.stringify(
          {
            ...agentMeta(agent),
            sandboxDir: `/sandbox/${subagentDir(agent.id)}`,
            transcripts: path.relative(path.dirname(recordsDir), path.join(transcriptDir, "agents", agent.id)),
            finishedAt: agent.finishedAt,
            status: agent.state.state,
            ...extra,
          },
          null,
          2,
        ),
      );
    } catch {
      // best effort
    }
  }

  function subagentStartText(agent) {
    const dir = `/sandbox/${subagentDir(agent.id)}`;
    return [
      `You are subagent ${agent.id}, started by ${agent.parentId === ROOT_AGENT_ID ? "the main research session" : `subagent ${agent.parentId}`}.`,
      "",
      `## Subtask: ${agent.title}`,
      agent.instructions,
      ...(agent.conditions?.length
        ? ["", "## Conditions set by the approving advisor", ...agent.conditions.map((c) => `- ${c}`)]
        : []),
      "",
      `Begin by inspecting ${dir}/ and the parts of /sandbox relevant to the subtask, then`,
      `decompose the subtask into goals and write ${dir}/GOALS.md (your own goals file; never edit`,
      "/sandbox/GOALS.md or another agent's GOALS.md). Propose the first goal with submit_plan.",
      "Do not execute before the advisor approves.",
    ].join("\n");
  }

  /** The advisor approved a pending proposal of `parent`: start the child. */
  function spawnSubagent(parent, approval) {
    const proposal = parent.pendingProposal?.payload || {};
    parent.pendingProposal = null;
    const id = `S${++subagentSeq}`;
    const meta = {
      id,
      parentId: parent.id,
      depth: parent.depth + 1,
      title: String(proposal.title || id),
      goalId: proposal.goalId ?? null,
      instructions: String(proposal.instructions || ""),
      conditions: Array.isArray(approval.payload?.conditions) ? approval.payload.conditions : [],
      advisory: Array.isArray(approval.payload?.advisory) ? approval.payload.advisory : [],
      createdAt: Date.now(),
    };
    const child = newSubagentRecord(meta);
    child.snapshot = snapshotProtectedGoals(id);
    agents.set(id, child);
    try {
      const dir = path.join(recordsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "goals-snapshot.json"), JSON.stringify(child.snapshot, null, 2));
      fs.writeFileSync(
        path.join(dir, "instructions.md"),
        [
          `# ${meta.title}`,
          "",
          meta.instructions,
          ...(proposal.expectedOutputs?.length
            ? ["", "## Expected outputs", ...proposal.expectedOutputs.map((o) => `- ${o}`)]
            : []),
          ...(meta.conditions.length ? ["", "## Conditions", ...meta.conditions.map((c) => `- ${c}`)] : []),
        ].join("\n") + "\n",
      );
    } catch {
      // best effort
    }
    writeRecord(child);
    activeId = id;
    logSession("subagent_start", {
      agentId: id,
      parentId: parent.id,
      meta,
      protectedFiles: Object.keys(child.snapshot),
    });
    deliver("researcher", { role: "control", kind: "start", text: subagentStartText(child), payload: {}, ts: Date.now() }, id);
  }

  /**
   * Called on a subagent's request_task_completion: it must have written its
   * report, and must not have changed any protected GOALS.md. Changed files
   * are restored from the snapshot. Returns the problems found (empty = ok).
   */
  function checkSubagentCompletion(agent) {
    if (!researcherSandbox) return [];
    const problems = [];
    const dir = subagentDir(agent.id);
    let report = "";
    try {
      report = fs.readFileSync(sandboxFile(`${dir}/REPORT.md`), "utf8");
    } catch {
      // missing
    }
    if (!report.trim()) {
      problems.push(
        `/sandbox/${dir}/REPORT.md is missing or empty; write your report there before calling request_task_completion`,
      );
    }
    const changed = [];
    for (const [rel, content] of Object.entries(agent.snapshot || {})) {
      let now = null;
      try {
        now = fs.readFileSync(sandboxFile(rel), "utf8");
      } catch {
        // deleted
      }
      if (now === content) continue;
      changed.push(`/sandbox/${rel}`);
      try {
        fs.mkdirSync(path.dirname(sandboxFile(rel)), { recursive: true });
        fs.writeFileSync(sandboxFile(rel), content);
      } catch {
        // best effort
      }
    }
    if (changed.length) {
      logSession("protected_restored", { agentId: agent.id, files: changed });
      problems.push(
        `you modified protected goal files (${changed.join(", ")}). The harness restored them from ` +
          `the snapshot taken when you started; only /sandbox/${dir}/GOALS.md is yours to edit. ` +
          "Check that your work and REPORT.md do not depend on those edits, then call " +
          "request_task_completion again",
      );
    }
    return problems;
  }

  function readReport(agentId) {
    try {
      return fs.readFileSync(sandboxFile(`${subagentDir(agentId)}/REPORT.md`), "utf8");
    } catch {
      return "";
    }
  }

  /** A subagent's task completion was accepted: report back to the parent. */
  function finishSubagent(child) {
    child.finishedAt = Date.now();
    const parent = agents.get(child.parentId);
    const report = readReport(child.id);
    const dir = subagentDir(child.id);
    try {
      fs.mkdirSync(path.join(recordsDir, child.id), { recursive: true });
      fs.writeFileSync(path.join(recordsDir, child.id, "REPORT.md"), report);
    } catch {
      // best effort
    }
    writeRecord(child);
    const inline =
      report.length > MAX_INLINE_REPORT_CHARS
        ? `${report.slice(0, MAX_INLINE_REPORT_CHARS)}\n\n[... truncated; read the full file]`
        : report;
    logSession("subagent_done", {
      agentId: child.id,
      parentId: child.parentId,
      title: child.title,
      report: inline,
    });
    const reportEnvelope = {
      role: "control",
      kind: "prompt",
      goalId: child.goalId ?? null,
      text: [
        `[subagent ${child.id} finished] "${child.title}"`,
        "",
        `Its advisor accepted the result. Report (/sandbox/${dir}/REPORT.md):`,
        "",
        inline.trim() || "(empty)",
        "",
        `Its working files are under /sandbox/${dir}/ (and wherever the report points).`,
        "Review the report critically, integrate the outcome into your own work and GOALS.md,",
        "then continue with your current phase (end it with the appropriate control tool).",
      ].join("\n"),
      payload: { subagentId: child.id, title: child.title, reportPath: `/sandbox/${dir}/REPORT.md` },
      ts: Date.now(),
    };
    // Close the child's conversations in both processes.
    for (const role of roles) {
      deliver(role, { role: "control", kind: "agent_done", text: "", payload: {}, ts: Date.now() }, child.id);
    }
    if (!parent) return;
    // The parent's advisor did not act on this, but should know the outcome
    // when it next reviews work that builds on it.
    deferNote(
      parent.id,
      "advisor",
      [
        `[subagent report] Subagent ${child.id} ("${child.title}") finished; its report is at`,
        `/researcher-sandbox/${dir}/REPORT.md:`,
        "",
        inline.trim() || "(empty)",
      ].join("\n"),
    );
    const r = applySubagentDone(parent.state, reportEnvelope);
    if (r.error) return;
    parent.state = r.state;
    activeId = parent.id;
    acceptDeliveries(r, parent.id);
  }

  /**
   * Handle an agent handoff envelope.
   * @returns {{ok: boolean, error?: string, state: string}}
   */
  function receiveAgentEnvelope(role, envelope) {
    const agentId = envelope?.agentId || ROOT_AGENT_ID;
    const agent = agents.get(agentId);
    const stateNow = () => agents.get(agentId)?.state.state ?? rootAgent().state.state;
    if (closed) return { ok: false, error: "session closed", state: stateNow() };
    if (!envelope || envelope.role !== role) {
      return { ok: false, error: "envelope role mismatch", state: stateNow() };
    }
    if (!agent) return { ok: false, error: `unknown agent: ${agentId}`, state: stateNow() };
    if (agentId !== activeId) {
      return { ok: false, error: `agent ${agentId} is not active (active: ${activeId})`, state: stateNow() };
    }
    // Not this role's turn (e.g. a stale message made it act again after its
    // handoff): refuse quietly. A correction prompt would start yet another
    // out-of-turn phase; instead the agent waits for its next message.
    const expectedNow = expectedRole(agent.state.state);
    if (expectedNow !== role) {
      const error =
        `not your turn: ${expectedNow ? `the ${expectedNow}` : "nobody (waiting on a human or a subagent)"} ` +
        `is expected to act in state ${agent.state.state}; your handoff was discarded. Wait for the next message`;
      logSession("reject", { from: role, agentId, error, outOfTurn: true, handoffKind: envelope.kind });
      events.emit("state", snapshot());
      return { ok: false, error, state: stateNow(), wait: true };
    }
    const valid = validateEnvelope(envelope);
    if (!valid.ok) {
      deliverCorrection(role, valid.error);
      return { ok: false, error: valid.error, state: stateNow() };
    }
    if (agent.state.state === STATES.RESEARCHER_INSTALL_SKILLS && envelope.kind === "skills_ready") {
      const missing = missingInstalledSkills(envelope.payload);
      if (missing.length) {
        const error = `confirm_skills_installed lists skills not found under /sandbox/skills: ${missing.join(", ")}. Install them with install_skill first.`;
        deliverCorrection(role, error);
        return { ok: false, error, state: stateNow() };
      }
    }
    if (envelope.kind === "subagent_proposal") {
      const error = checkSubagentProposal(agent, envelope.payload);
      if (error) {
        deliverCorrection(role, error);
        return { ok: false, error, state: stateNow() };
      }
    }
    if (
      agent.state.subagent &&
      envelope.kind === "task_request" &&
      [STATES.RESEARCHER_DECOMPOSE, STATES.RESEARCHER_EXECUTE].includes(agent.state.state)
    ) {
      const problems = checkSubagentCompletion(agent);
      if (problems.length) {
        const error = `completion refused: ${problems.join("; ")}`;
        deliverCorrection(role, error);
        return { ok: false, error, state: stateNow() };
      }
    }
    logSession("handoff", {
      from: role,
      agentId,
      handoffKind: envelope.kind,
      goalId: envelope.goalId ?? null,
      text: envelope.text || "",
      payload: envelope.payload || {},
    });
    const result = applyEnvelope(agent.state, envelope);
    if (result.error) {
      deliverCorrection(role, result.error);
      return { ok: false, error: result.error, state: stateNow() };
    }
    agent.state = result.state;
    // The cap bounds *consecutive* invalid handoffs; any accepted one is progress.
    rejections = 0;
    if (role === "researcher" && (envelope.kind === "proposal" || envelope.kind === "result")) {
      researcherSteps += 1;
    }
    if (envelope.kind === "subagent_proposal") agent.pendingProposal = envelope;
    if (envelope.kind === "proposal") agent.lastPlanExecution = envelope.payload?.execution || null;
    acceptDeliveries(result, agentId);
    if (agentId === ROOT_AGENT_ID) finishIfTerminal(result);
    if (result.spawn) spawnSubagent(agent, envelope);
    if (result.terminal === "subagent_done") finishSubagent(agent);
    const root = rootAgent().state;
    if (maxHandoffs > 0 && researcherSteps >= maxHandoffs && root.state !== STATES.DONE) {
      abort(`max researcher steps reached (${maxHandoffs})`);
    }
    events.emit("state", snapshot());
    return { ok: true, state: stateNow() };
  }

  /** Reasons a subagent proposal is refused before it reaches the advisor. */
  function checkSubagentProposal(agent, payload) {
    if (maxSubagentDepth != null && agent.depth + 1 > maxSubagentDepth) {
      return maxSubagentDepth === 0
        ? "subagents are disabled for this session"
        : `subagent depth limit reached (max ${maxSubagentDepth}); do this work yourself`;
    }
    if (!String(payload?.instructions || "").trim()) {
      return "propose_subagent needs non-empty `instructions`";
    }
    return null;
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
        return { role: "researcher", actions: ["submit_plan", "propose_subagent", "request_task_completion"] };
      case STATES.RESEARCHER_EXECUTE:
        return {
          role: "researcher",
          actions: ["submit_result", "submit_plan", "propose_subagent", "request_task_completion"],
        };
      case STATES.ADVISOR_REVIEW_PLAN:
        return { role: "advisor", actions: ["approve_plan", "request_plan_changes"] };
      case STATES.ADVISOR_REVIEW_RESULT:
        return { role: "advisor", actions: ["accept_result", "request_result_changes"] };
      case STATES.ADVISOR_REVIEW_TASK:
        return { role: "advisor", actions: ["accept_task_completion", "request_task_changes"] };
      case STATES.ADVISOR_REVIEW_SUBAGENT:
        return { role: "advisor", actions: ["approve_subagent", "reject_subagent"] };
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
    logSession("reject", { from: role, agentId: activeId, error, rejections });
    if (maxRejections > 0 && rejections >= maxRejections) {
      deliver(role, {
        role: "control",
        kind: "prompt",
        text: `Too many consecutive invalid handoffs (${rejections}); aborting. Last error: ${error}`,
        payload: {},
        ts: Date.now(),
      });
      abort(`too many consecutive invalid handoffs (${rejections})`);
      return;
    }
    const stateValue = activeAgent().state.state;
    const expected = expectedForState(stateValue);
    const actions = expected.actions.length
      ? expected.actions.map((a) => `\`${a}\``).join(", ")
      : "(none)";
    deliver(role, {
      role: "control",
      kind: "prompt",
      text: [
        `Your last handoff was rejected by the orchestrator: ${error}.`,
        "",
        `The session is currently in state ${stateValue}.`,
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
    const root = rootAgent();
    if (closed) return { ok: false, error: "session closed", state: root.state.state };
    logSession("human_decision", { ...decision, agentId: ROOT_AGENT_ID });
    const result = applyHumanDecision(root.state, decision);
    if (result.error) return { ok: false, error: result.error, state: root.state.state };
    root.state = result.state;
    acceptDeliveries(result, ROOT_AGENT_ID);
    finishIfTerminal(result);
    events.emit("state", snapshot());
    return { ok: true, state: root.state.state, terminal: result.terminal || null };
  }

  /**
   * Inject a human note for `target` of agent `agentId` (default: the active
   * agent). It is delivered now when that agent/role is expected to act, and
   * otherwise held and merged into its next handoff.
   */
  function humanMessage(target, text, payload = {}, agentId = null) {
    if (closed) return { ok: false, error: "session closed" };
    if (!roles.includes(target)) return { ok: false, error: `invalid target: ${target}` };
    const id = agentId || activeId;
    const agent = agents.get(id);
    if (!agent) return { ok: false, error: `unknown agent: ${id}` };
    if (agent.state.state === STATES.DONE || agent.state.state === STATES.ABORTED) {
      return { ok: false, error: `agent ${id} has finished` };
    }
    if (expectedRole(activeAgent().state.state) === null) {
      return { ok: false, error: "no agent is expected to act right now" };
    }
    const expected = id === activeId ? expectedRole(agent.state.state) : null;
    if (expected !== target) {
      // Hold the note until it is this agent/role's turn, then merge it into
      // the handoff that triggers them (avoids acting out of turn).
      deferNote(id, target, `[human note] ${text}`);
      logSession("human_message_deferred", { to: target, agentId: id, expects: expected, text });
      events.emit("state", snapshot());
      return {
        ok: true,
        deferred: true,
        deferredUntil: id === activeId ? expected : `${id} resumes`,
      };
    }
    logSession("human_message", { to: target, agentId: id, text });
    deliver(
      target,
      {
        role: "human",
        kind: "human_message",
        goalId: agent.state.currentGoalId,
        text,
        payload,
        ts: Date.now(),
      },
      id,
    );
    events.emit("state", snapshot());
    return { ok: true };
  }

  function abort(reason) {
    if (closed) return;
    const root = rootAgent();
    // Agents may exit non-zero while being stopped after approval; keep DONE.
    if (root.state.state === STATES.DONE) return complete();
    closed = true;
    for (const agent of agents.values()) {
      if (agent.id !== ROOT_AGENT_ID && agent.state.state !== STATES.DONE) {
        agent.state = markAborted(agent.state, reason).state;
        writeRecord(agent);
      }
    }
    root.state = markAborted(root.state, reason).state;
    logSession("abort", { reason });
    broadcastControl("abort", reason);
    events.emit("state", snapshot());
  }

  function complete() {
    if (closed) return;
    closed = true;
    logSession("closed", { reason: rootAgent().state.terminalReason || "done" });
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

  function agentSummaries() {
    return [...agents.values()].map((a) => ({
      id: a.id,
      parentId: a.parentId,
      depth: a.depth,
      title: a.title,
      goalId: a.goalId ?? null,
      state: a.state.state,
      currentGoalId: a.state.currentGoalId,
      expecting: a.id === activeId ? expectedRole(a.state.state) : null,
      active: a.id === activeId,
      createdAt: a.createdAt ?? a.state.startedAt,
      finishedAt: a.finishedAt ?? null,
    }));
  }

  function snapshot() {
    const root = rootAgent().state;
    const active = activeAgent();
    let handoffs = 0;
    for (const a of agents.values()) handoffs += a.state.handoffs || 0;
    return {
      sessionId,
      state: root.state,
      currentGoalId: root.currentGoalId,
      handoffs,
      researcherSteps,
      humanDecisions: root.humanDecisions,
      registered: Object.fromEntries([...registered.entries()].map(([r, v]) => [r, Boolean(v)])),
      startedAt: root.startedAt,
      finishedAt: root.finishedAt,
      terminalReason: root.terminalReason,
      expecting: expectedRole(active.state.state),
      activeAgent: activeId,
      activeState: active.state.state,
      agents: agentSummaries(),
    };
  }

  /** Subagent metadata, instructions and (when finished) report, for the UI. */
  function agentInfo(agentId) {
    const agent = agents.get(agentId);
    if (!agent) return null;
    if (agent.id === ROOT_AGENT_ID) return { id: agent.id, root: true };
    return {
      ...agentMeta(agent),
      state: agent.state.state,
      finishedAt: agent.finishedAt,
      report: agent.state.state === STATES.DONE ? readReport(agent.id) : "",
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
    agentInfo,
    register(role) {
      if (!roles.includes(role)) throw new Error(`unknown role: ${role}`);
      registered.set(role, Date.now());
      events.emit("state", snapshot());
      return { ok: true, registered: snapshot().registered };
    },
    /**
     * Restore a previously-replayed state (used by --view so a completed run
     * shows its final state without starting containers) and broadcast it.
     * `agents`/`activeId` (from replaySessionLog) restore the subagent tree.
     */
    seed(nextState, { agents: seededAgents = null, activeId: seededActive = null } = {}) {
      rootAgent().state = { ...nextState };
      for (const a of seededAgents || []) {
        const agent = { ...a };
        // A run that ended early left its unfinished subagents behind.
        if (nextState.state === STATES.ABORTED && agent.state.state !== STATES.DONE) {
          agent.state = markAborted(agent.state, nextState.terminalReason || "aborted").state;
        }
        agents.set(agent.id, agent);
      }
      if (seededActive && agents.has(seededActive)) activeId = seededActive;
      events.emit("state", snapshot());
      return snapshot();
    },
    isClosed: () => closed,
    get state() {
      return rootAgent().state;
    },
    set state(v) {
      rootAgent().state = v;
    },
  };
}
