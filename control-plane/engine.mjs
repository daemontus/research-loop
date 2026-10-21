/**
 * Protocol engine: the whole run as one deterministic model (sessions, goals,
 * whose turn it is), driven by a small set of inputs:
 *
 *   start, handoff (an agent's control tool), skillsInstalled (harness
 *   installer ack), humanDecision, humanMessage
 *
 * Every input returns `{ ok, error?, wait?, effects }`. Effects describe what
 * the broker must do (deliver an envelope, write run-folder records, end the
 * run); the engine itself never does I/O. Because the same inputs always lead
 * to the same model, `replay()` rebuilds a run from its control-plane log for
 * --resume and --view, ignoring the effects.
 *
 * See docs/PROTOCOL.md for the protocol this implements.
 */
import {
  allowedActions,
  actionsForRole,
  INITIAL_STATE,
  isTerminal,
  nextState,
  STATE_ACTOR,
  STATES,
} from "./state-machine.mjs";
import { GoalStore, normalizeGoal, renderGoal, renderGoalList } from "./goal-store.mjs";
import * as T from "./harness-text.mjs";
import { renderInbound } from "../agent/lib/protocol.mjs";

export const ROOT_ID = "root";
export const SKILLS_ID = "skills";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const strList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : []);

/**
 * @param {object} opts
 * @param {string} opts.task
 * @param {string} [opts.initialNote]
 * @param {boolean} [opts.skipSkills]
 * @param {string[]} [opts.preinstalledSkills] skill names present before the run
 * @param {number|null} [opts.maxSubagentDepth] null = unlimited (minimum 1)
 * @param {number} [opts.maxPlanChanges] 0 = unlimited
 * @param {number} [opts.maxSubagentRejections] 0 = unlimited (per goal)
 */
export function createEngine(opts = {}) {
  const cfg = {
    task: opts.task || "",
    initialNote: opts.initialNote || "",
    skipSkills: Boolean(opts.skipSkills),
    preinstalledSkills: [...(opts.preinstalledSkills || [])],
    maxSubagentDepth: opts.maxSubagentDepth ?? null,
    maxPlanChanges: opts.maxPlanChanges || 0,
    maxSubagentRejections: opts.maxSubagentRejections || 0,
  };
  const goals = new GoalStore();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  const run = {
    status: "idle", // idle | running | done | aborted
    startedAt: null,
    finishedAt: null,
    terminalReason: null,
    humanDecisions: [],
  };
  const skills = { approved: [], installed: {}, names: [...cfg.preinstalledSkills] };
  // Per agent-and-role conversation: notes to merge into its next delivery,
  // context operations to apply before its next phase, and lost contexts.
  const deferred = new Map();
  const contextOps = new Map();
  const stale = new Set();
  // The last message each agent was given to work on (not corrections or
  // human notes): repeated on resume, since the conversation holding it is lost.
  const lastMessage = new Map();
  let activeId = null;
  let subagentSeq = 0;
  let handoffs = 0;
  let fx = [];

  const key = (sid, role) => `${sid}:${role}`;
  const ownerOf = (s) => (s.kind === "main" ? ROOT_ID : s.id);
  const session = (id) => sessions.get(id) || null;
  const active = () => session(activeId);

  function meta(s) {
    return {
      id: s.id,
      kind: s.kind,
      parentId: s.parentId,
      depth: s.depth,
      goalId: s.goalId,
      title: s.title,
      brief: s.brief || "",
    };
  }

  function deliver(role, sid, envelope) {
    const k = key(sid, role);
    let env = { ts: Date.now(), payload: {}, ...envelope };
    const carries = !["agent_done", "install_skills", "abort", "session_done"].includes(env.kind);
    if (carries) {
      const notes = deferred.get(k);
      if (notes?.length) {
        env.text = `${notes.join("\n\n")}\n\n${env.text || ""}`.trim();
        deferred.delete(k);
      }
      if (stale.has(k)) {
        stale.delete(k);
        env.text = [
          "[harness] This run was RESUMED in a fresh container while you were waiting: your earlier",
          "conversation is gone. Re-orient yourself from your system prompt, list_goals / read_goal and",
          "the files in the sandbox, then handle the message below.",
          "",
          env.text || "",
        ].join("\n").trim();
      }
      const ops = contextOps.get(k);
      if (ops?.length) {
        env.contextOps = ops;
        contextOps.delete(k);
      }
    }
    const s = session(sid);
    if (carries && !env.correction && env.kind !== "human_message") lastMessage.set(k, env);
    fx.push({ type: "deliver", role, envelope: { ...env, agentId: sid, agent: s ? meta(s) : null } });
  }

  function defer(sid, role, text) {
    const k = key(sid, role);
    if (!deferred.has(k)) deferred.set(k, []);
    deferred.get(k).push(text);
  }

  /** Forward an agent's handoff to its peer, with a markdown body and next-step text. */
  function forward(to, s, from, envelope, next) {
    deliver(to, s.id, {
      role: from,
      kind: envelope.kind,
      goalId: envelope.goalId ?? null,
      text: envelope.text || "",
      payload: envelope.payload || {},
      body: T.renderPayload(envelope.kind, envelope.payload || {}),
      next,
    });
  }

  function prompt(role, sid, text, kind = "prompt", extra = {}) {
    deliver(role, sid, { role: "control", kind, text, ...extra });
  }

  function setState(s, action, when = null) {
    const r = nextState(s.kind, s.state, action, when);
    if (r.error) throw new Error(r.error); // validated by the caller
    s.state = r.to;
    return r.to;
  }

  function newSession(fields, ts) {
    const s = {
      parentId: null,
      depth: 0,
      goalId: null,
      title: "",
      instructions: "",
      conditions: [],
      brief: "",
      createdAt: ts,
      finishedAt: null,
      terminalReason: null,
      pending: {},
      humanRequest: null,
      rejections: {},
      planChanges: 0,
      outcome: null,
      ...fields,
    };
    s.state = INITIAL_STATE[s.kind];
    sessions.set(s.id, s);
    return s;
  }

  // ---- depth --------------------------------------------------------------

  /** May a child at `childDepth` be an orchestrator (spawn at childDepth + 1)? */
  function splitAllowed(childDepth) {
    return cfg.maxSubagentDepth == null || childDepth + 1 <= cfg.maxSubagentDepth;
  }
  function depthNote(childDepth) {
    return `the subagent would be at depth ${childDepth}, the maximum (--max-subagent-depth ${cfg.maxSubagentDepth})`;
  }

  // ---- state instructions (corrections, resume) ---------------------------

  function instructionsFor(s) {
    const owner = ownerOf(s);
    switch (s.state) {
      case STATES.SKILLS_PROPOSE:
        return T.skillsProposeText({ task: cfg.task, initialNote: cfg.initialNote, preinstalled: cfg.preinstalledSkills });
      case STATES.SKILLS_REVIEW:
        return T.SKILLS_REVIEW_TEXT;
      case STATES.PLAN_DRAFT:
        return T.planDraftText({ task: cfg.task, initialNote: cfg.initialNote, installedSkills: skills.names });
      case STATES.PLAN_REVIEW:
        return T.PLAN_REVIEW_TEXT;
      case STATES.GOAL_PREPARE: {
        const goal = goals.current(owner);
        return goal
          ? T.prepareText({ goal, splitAllowed: splitAllowed(s.depth + 1), depthNote: depthNote(s.depth + 1), kind: s.kind })
          : "";
      }
      case STATES.SUBAGENT_REVIEW: {
        const goal = goals.get(s.pending.delegation?.goalId);
        return goal ? T.subagentReviewText({ goal, splitAllowed: splitAllowed(s.depth + 1) }) : "";
      }
      case STATES.REFLECT:
        return T.reflectOptions({ kind: s.kind, nextGoal: goals.current(owner) });
      case STATES.PLAN_CHANGE_REVIEW:
        return T.planChangeReviewText({ currentList: renderGoalList(goals.list(owner)) });
      case STATES.FINAL_CHECK:
        return T.finalCheckText({ goal: goals.get(s.goalId), subgoals: renderGoalList(goals.list(s.id)) });
      case STATES.WORK:
        return T.WORK_TEXT;
      case STATES.RESULT_REVIEW:
        return T.resultReviewText({ goal: goals.get(s.goalId) });
      case STATES.ABORT_REVIEW:
        return T.ABORT_REVIEW_TEXT;
      default:
        return "";
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  function start(ts = Date.now()) {
    fx = [];
    if (run.status !== "idle") return { ok: false, error: "run already started", effects: fx };
    run.status = "running";
    run.startedAt = ts;
    if (cfg.skipSkills) {
      startMain(ts);
    } else {
      const s = newSession({ id: SKILLS_ID, kind: "skills", title: "Skills" }, ts);
      activeId = s.id;
      fx.push({ type: "session_started", session: snapshotSession(s) });
      prompt("researcher", s.id, instructionsFor(s), "start");
    }
    return { ok: true, effects: fx };
  }

  function startMain(ts) {
    const s = newSession({ id: ROOT_ID, kind: "main", title: "Main task" }, ts);
    activeId = s.id;
    fx.push({ type: "session_started", session: snapshotSession(s) });
    prompt("advisor", s.id, instructionsFor(s), "start");
  }

  // ---- agent handoffs -----------------------------------------------------

  /**
   * An agent called a control tool. `envelope.kind` is the tool name.
   * @returns {{ ok: boolean, error?: string, wait?: boolean, effects: object[] }}
   */
  function handoff(role, sid, envelope, ts = Date.now()) {
    fx = [];
    const s = session(sid);
    const fail = (error, extra = {}) => ({ ok: false, error, effects: fx, ...extra });
    if (run.status !== "running") return fail(`the run is ${run.status}`);
    if (!s) return fail(`unknown session: ${sid}`);
    if (sid !== activeId) return fail(`session ${sid} is not active (active: ${activeId})`, { wait: true });
    const actor = STATE_ACTOR[s.state];
    if (actor !== role) {
      return fail(
        `not your turn: ${actor === "human" ? "the human" : actor ? `the ${actor}` : "nobody"} acts in state ${s.state}`,
        { wait: true },
      );
    }
    const action = envelope?.kind;
    if (!actionsForRole(s.kind, role).includes(action)) {
      return fail(`'${action}' is not a ${role} action in a ${s.kind} session`);
    }
    const allowed = allowedActions(s.kind, s.state);
    if (!allowed.includes(action)) {
      return fail(`'${action}' is not allowed in state ${s.state}; expected one of: ${allowed.join(", ")}`);
    }
    const handler = HANDLERS[action];
    const error = handler(s, envelope, ts);
    if (error) {
      fx = [];
      return fail(error);
    }
    handoffs += 1;
    fx.push({ type: "state" });
    return { ok: true, effects: fx };
  }

  const p = (envelope) => envelope.payload || {};

  const HANDLERS = {
    // --- skills ---
    propose_skills(s, env) {
      const payload = p(env);
      const list = Array.isArray(payload.skills) ? payload.skills : [];
      const normalized = [];
      for (const [i, raw] of list.entries()) {
        const source = str(raw?.source);
        if (!source) return `skill #${i + 1}: source is required (as skills.sh shows it, e.g. owner/repo)`;
        normalized.push({ name: str(raw?.name) || source, source, skill: str(raw?.skill) || null, why: str(raw?.why) });
      }
      if (!normalized.length && !payload.noneNeeded) {
        return "propose at least one skill, or set noneNeeded with a justification in `summary`";
      }
      s.pending.skills = normalized;
      setState(s, "propose_skills");
      forward("advisor", s, "researcher", env, T.SKILLS_REVIEW_TEXT);
    },
    request_skill_changes(s, env) {
      setState(s, "request_skill_changes");
      forward("researcher", s, "advisor", env, "Revise the proposal and call propose_skills again.");
    },
    approve_skills(s, env, ts) {
      skills.approved = s.pending.skills || [];
      if (!skills.approved.length) {
        setState(s, "approve_skills", "nothing to install");
        finishSkills(s, ts);
        return;
      }
      setState(s, "approve_skills", "skills to install");
      for (const role of ["researcher", "advisor"]) {
        deliver(role, s.id, { role: "control", kind: "install_skills", text: "", payload: { skills: skills.approved } });
      }
    },

    // --- main: planning ---
    propose_plan(s, env) {
      const error = goals.validate(p(env).goals, { owner: ROOT_ID });
      if (error) return error;
      s.pending.plan = p(env).goals.map(normalizeGoal);
      setState(s, "propose_plan");
      forward("researcher", s, "advisor", env, T.PLAN_REVIEW_TEXT);
    },
    request_plan_changes(s, env) {
      setState(s, "request_plan_changes");
      forward("advisor", s, "researcher", env, "Address the requested changes and call propose_plan with the revised plan.");
    },
    accept_plan(s, env, ts) {
      goals.register(ROOT_ID, s.pending.plan, ts);
      s.pending.plan = null;
      fx.push({ type: "plan_version", owner: ROOT_ID, version: 1, goals: goals.snapshot(ROOT_ID) });
      // The accepted plan is now the record; drop the exploration around it.
      const keep = { op: "prune_tool_calls", keep: ["propose_plan", "accept_plan"] };
      for (const role of ["researcher", "advisor"]) contextOps.set(key(s.id, role), [keep]);
      const feedback = str(p(env).feedback);
      defer(s.id, "advisor", `[harness] The researcher accepted your plan.${feedback ? ` Feedback: ${feedback}` : ""}`);
      setState(s, "accept_plan");
      prompt("researcher", s.id, instructionsFor(s));
    },

    // --- goal loop ---
    propose_subagent(s, env) {
      const payload = p(env);
      const goal = goals.current(ownerOf(s));
      if (!goal) return "there is no planned goal to delegate";
      if (str(payload.goalId) !== goal.id) {
        return `goals are worked on in order: the next goal is ${goal.id}, not ${str(payload.goalId) || "(none)"}`;
      }
      const mode = payload.mode;
      if (mode !== "full" && mode !== "split") return "`mode` must be \"full\" or \"split\"";
      if (!str(payload.instructions)) return "`instructions` are required";
      if (!str(payload.justification)) return "`justification` of the scope decision is required";
      const childDepth = s.depth + 1;
      if (mode === "split") {
        if (!splitAllowed(childDepth)) return `mode "split" is not available: ${depthNote(childDepth)}; use mode "full"`;
        const error = goals.validate(payload.subgoals, { owner: null, prefix: goal.id, minCount: 2 });
        if (error) return `subgoals: ${error}`;
      } else if (Array.isArray(payload.subgoals) && payload.subgoals.length) {
        return "`subgoals` are only allowed with mode \"split\"";
      }
      s.pending.delegation = {
        goalId: goal.id,
        mode,
        instructions: str(payload.instructions),
        justification: str(payload.justification),
        subgoals: mode === "split" ? payload.subgoals.map(normalizeGoal) : [],
      };
      setState(s, "propose_subagent");
      forward("advisor", s, "researcher", env, T.subagentReviewText({ goal, splitAllowed: splitAllowed(childDepth) }));
    },
    reject_subagent(s, env, ts) {
      const goalId = s.pending.delegation?.goalId;
      s.rejections[goalId] = (s.rejections[goalId] || 0) + 1;
      s.pending.delegation = null;
      const capped = cfg.maxSubagentRejections > 0 && s.rejections[goalId] >= cfg.maxSubagentRejections;
      if (!capped) {
        setState(s, "reject_subagent", "below rejection cap");
        forward("researcher", s, "advisor", env, instructionsFor(s));
        return;
      }
      const reason = `the delegation of ${goalId} was rejected ${s.rejections[goalId]} times (--max-subagent-rejections)`;
      setState(s, "reject_subagent", "rejection cap reached");
      if (s.kind === "main") {
        s.humanRequest = { type: "abort", reason, report: "", notes: "" };
        fx.push({ type: "awaiting_human", request: s.humanRequest });
      } else {
        endSession(s, { reason, report: "", notes: "", verdict: "" }, ts);
      }
    },
    approve_subagent(s, env, ts) {
      const d = s.pending.delegation;
      s.pending.delegation = null;
      const goal = goals.get(d.goalId);
      const id = `S${++subagentSeq}`;
      const kind = d.mode === "split" ? "orchestrator" : "leaf";
      const conditions = strList(p(env).conditions);
      Object.assign(goal, {
        status: "in_progress",
        childId: id,
        mode: d.mode,
        instructions: d.instructions,
        justification: d.justification,
        conditions,
        startedAt: ts,
      });
      const child = newSession(
        {
          id,
          kind,
          parentId: s.id,
          depth: s.depth + 1,
          goalId: goal.id,
          title: goal.title,
          instructions: d.instructions,
          conditions,
        },
        ts,
      );
      if (kind === "orchestrator") {
        goals.register(id, d.subgoals, ts);
        fx.push({ type: "plan_version", owner: id, version: 1, goals: goals.snapshot(id) });
      }
      child.brief = T.childBrief({
        child,
        goal,
        chain: goalChain(goal),
        siblings: goals.finishedBefore(goal.id),
        subgoals: kind === "orchestrator" ? goals.list(id) : null,
      });
      const feedback = str(p(env).feedback);
      if (feedback) defer(s.id, "researcher", `[harness] The advisor approved delegating ${goal.id}: ${feedback}`);
      setState(s, "approve_subagent");
      activeId = id;
      fx.push({ type: "session_started", session: snapshotSession(child) });
      fx.push({ type: "goals_changed" });
      prompt(
        "researcher",
        id,
        kind === "leaf"
          ? `You are subagent ${id}. Your goal and context are in your system prompt.\n\n${T.WORK_TEXT}`
          : `You are subagent ${id}, an orchestrator for ${goal.id}. Your goal and subgoals are in your system prompt.\n\n${instructionsFor(child)}`,
        "start",
      );
    },
    proceed(s) {
      if (!goals.current(ownerOf(s))) return "no planned goals are left; call finish_session (or abort_session)";
      setState(s, "proceed", "planned goals left");
      prompt("researcher", s.id, instructionsFor(s));
    },
    propose_plan_change(s, env) {
      if (cfg.maxPlanChanges > 0 && s.planChanges >= cfg.maxPlanChanges) {
        return `the plan was already changed ${s.planChanges} times (--max-plan-changes); proceed, finish or abort instead`;
      }
      const error = goals.validate(p(env).goals, { owner: ROOT_ID, replacing: true, allowEmpty: true });
      if (error) return error;
      if (!str(p(env).rationale)) return "`rationale` is required";
      s.pending.planChange = p(env).goals.map(normalizeGoal);
      setState(s, "propose_plan_change");
      forward("advisor", s, "researcher", env, instructionsFor(s));
    },
    approve_plan_change(s, env, ts) {
      const version = goals.replacePlanned(ROOT_ID, s.pending.planChange, ts);
      s.pending.planChange = null;
      s.planChanges += 1;
      fx.push({ type: "plan_version", owner: ROOT_ID, version, goals: goals.snapshot(ROOT_ID) });
      fx.push({ type: "goals_changed" });
      const left = Boolean(goals.current(ROOT_ID));
      setState(s, "approve_plan_change", left ? "planned goals left" : "no planned goals left");
      forward("researcher", s, "advisor", env, instructionsFor(s));
    },
    reject_plan_change(s, env) {
      s.pending.planChange = null;
      setState(s, "reject_plan_change");
      forward("researcher", s, "advisor", env, instructionsFor(s));
    },
    finish_session(s, env) {
      const planned = goals.planned(ownerOf(s));
      if (planned.length) {
        return `goals are still planned (${planned.map((g) => g.id).join(", ")}); proceed with them${s.kind === "main" ? ", change the plan," : ""} or abort_session`;
      }
      const payload = p(env);
      if (s.kind === "main") {
        if (!str(payload.summary)) return "`summary` for the human is required";
        s.humanRequest = { type: "finish", summary: str(payload.summary), notes: str(payload.notes) };
        setState(s, "finish_session", "no planned goals left");
        fx.push({ type: "awaiting_human", request: s.humanRequest });
        return;
      }
      if (!str(payload.report)) return "`report` for the parent is required";
      s.pending.finish = { report: str(payload.report), notes: str(payload.notes) };
      setState(s, "finish_session", "no planned goals left");
      forward("advisor", s, "researcher", env, instructionsFor(s));
    },
    abort_session(s, env, ts) {
      const payload = p(env);
      if (!str(payload.reason)) return "`reason` is required";
      const outcome = {
        reason: str(payload.reason),
        report: str(payload.report),
        notes: str(payload.notes),
        proposal: str(payload.proposal),
        verdict: "",
      };
      if (s.kind === "main") {
        s.humanRequest = { type: "abort", ...outcome };
        setState(s, "abort_session");
        fx.push({ type: "awaiting_human", request: s.humanRequest });
        return;
      }
      setState(s, "abort_session");
      endSession(s, outcome, ts);
    },
    accept_completion(s, env, ts) {
      const f = s.pending.finish || {};
      setState(s, "accept_completion");
      endSession(s, { report: f.report, notes: f.notes, verdict: verdictText(env), reason: "" }, ts);
    },
    reject_completion(s, env, ts) {
      const f = s.pending.finish || {};
      setState(s, "reject_completion");
      endSession(s, { report: f.report, notes: f.notes, verdict: verdictText(env), reason: "final check: the goal is not met as a whole" }, ts);
    },

    // --- leaf ---
    submit_result(s, env) {
      const payload = p(env);
      if (!str(payload.report)) return "`report` for the parent is required";
      s.pending.result = { report: str(payload.report), notes: str(payload.notes) };
      setState(s, "submit_result");
      forward("advisor", s, "researcher", env, instructionsFor(s));
    },
    request_result_changes(s, env) {
      setState(s, "request_result_changes");
      forward("researcher", s, "advisor", env, "Address the required changes, then call submit_result again (or request_abort).");
    },
    accept_result(s, env, ts) {
      const r = s.pending.result || {};
      setState(s, "accept_result");
      endSession(s, { report: r.report, notes: r.notes, verdict: verdictText(env), reason: "" }, ts);
    },
    request_abort(s, env) {
      const payload = p(env);
      if (!str(payload.reason)) return "`reason` is required";
      s.pending.abort = {
        reason: str(payload.reason),
        report: str(payload.report),
        notes: str(payload.notes),
        proposal: str(payload.proposal),
      };
      setState(s, "request_abort");
      forward("advisor", s, "researcher", env, T.ABORT_REVIEW_TEXT);
    },
    reject_abort(s, env) {
      s.pending.abort = null;
      setState(s, "reject_abort");
      forward("researcher", s, "advisor", env, "Continue working on the goal; call submit_result when it is achieved.");
    },
    confirm_abort(s, env, ts) {
      const a = s.pending.abort || {};
      setState(s, "confirm_abort");
      endSession(s, { ...a, verdict: verdictText(env) }, ts);
    },
  };

  function verdictText(env) {
    const payload = p(env);
    return [str(payload.feedback), ...strList(payload.verification).map((v) => `- ${v}`), ...strList(payload.requiredChanges).map((v) => `- ${v}`)]
      .filter(Boolean)
      .join("\n");
  }

  /** Goals from the main plan down to `goal` (exclusive). */
  function goalChain(goal) {
    const chain = [];
    let owner = session(goal.owner);
    while (owner && owner.goalId) {
      const g = goals.get(owner.goalId);
      if (!g) break;
      chain.unshift(g);
      owner = session(g.owner);
    }
    return chain;
  }

  /** A child session ended (its state is already DONE/ABORTED): update its goal and resume the parent. */
  function endSession(child, outcome, ts) {
    child.finishedAt = ts;
    child.outcome = outcome;
    const done = child.state === STATES.DONE;
    child.terminalReason = done ? "done" : outcome.reason || "aborted";
    const goal = goals.get(child.goalId);
    Object.assign(goal, {
      status: done ? "done" : "aborted",
      report: outcome.report || "",
      notes: outcome.notes || "",
      verdict: outcome.verdict || "",
      endReason: done
        ? "done"
        : `aborted: ${outcome.reason || "no reason given"}${outcome.proposal ? `\nProposal: ${outcome.proposal}` : ""}`,
      finishedAt: ts,
    });
    if (child.kind === "orchestrator") goals.abortPlanned(child.id, "not started: its session ended", ts);
    for (const role of ["researcher", "advisor"]) deliver(role, child.id, { role: "control", kind: "agent_done", text: "" });
    fx.push({ type: "session_ended", session: snapshotSession(child), goal: { ...goal } });
    fx.push({ type: "goals_changed" });
    const parent = session(child.parentId);
    setState(parent, "child_ended");
    activeId = parent.id;
    defer(parent.id, "advisor", T.advisorChildSummary({ child, goal }));
    prompt("researcher", parent.id, T.reflectText({ kind: parent.kind, child, goal, nextGoal: goals.current(ownerOf(parent)) }));
  }

  function finishSkills(s, ts) {
    s.finishedAt = ts;
    s.terminalReason = "done";
    for (const role of ["researcher", "advisor"]) deliver(role, s.id, { role: "control", kind: "agent_done", text: "" });
    fx.push({ type: "skills", record: { approved: skills.approved, installed: skills.installed } });
    fx.push({ type: "session_ended", session: snapshotSession(s) });
    startMain(ts);
  }

  /** The harness installer in one agent process finished. */
  function skillsInstalled(role, payload = {}, ts = Date.now()) {
    fx = [];
    const s = session(SKILLS_ID);
    if (!s || s.state !== STATES.SKILLS_INSTALL) {
      return { ok: false, error: "no skill installation is pending", wait: true, effects: fx };
    }
    skills.installed[role] = {
      installed: Array.isArray(payload.installed) ? payload.installed : [],
      errors: Array.isArray(payload.errors) ? payload.errors : [],
    };
    if (role === "researcher") {
      for (const it of skills.installed[role].installed) {
        const name = str(it?.name) || str(it?.slug);
        if (name && !skills.names.includes(name)) skills.names.push(name);
      }
    }
    if (skills.installed.researcher && skills.installed.advisor) {
      setState(s, "skills_installed", "both sandboxes installed");
      finishSkills(s, ts);
    }
    fx.push({ type: "state" });
    return { ok: true, effects: fx };
  }

  // ---- human --------------------------------------------------------------

  function humanDecision(decision = {}, ts = Date.now()) {
    fx = [];
    const root = session(ROOT_ID);
    if (!root || root.state !== STATES.AWAITING_HUMAN) {
      return { ok: false, error: "no human decision is expected now", effects: fx };
    }
    run.humanDecisions.push({ ...decision, ts });
    const request = root.humanRequest;
    if (decision.action === "approve") {
      const aborting = request?.type === "abort";
      setState(root, "human_approve", aborting ? "abort requested" : "completion requested");
      root.finishedAt = ts;
      root.outcome = request;
      root.terminalReason = aborting ? `aborted (confirmed by the human): ${request.reason}` : "human approved task completion";
      root.humanRequest = null;
      if (aborting) goals.abortPlanned(ROOT_ID, "not started: the run was aborted", ts);
      finishRun(aborting ? "aborted" : "done", root.terminalReason, ts);
      return { ok: true, effects: fx };
    }
    if (decision.action === "reject" || decision.action === "extend") {
      root.humanRequest = null;
      setState(root, "human_reject");
      activeId = ROOT_ID;
      const text =
        str(decision.text) ||
        (decision.action === "extend"
          ? "The human granted more budget: continue the task and address the remaining gaps."
          : `The human did not accept the ${request?.type === "abort" ? "abort" : "completion"}: continue working.`);
      deliver("researcher", ROOT_ID, {
        role: "human",
        kind: "human_decision",
        text,
        payload: { action: decision.action },
        next: T.reflectOptions({ kind: "main", nextGoal: goals.current(ROOT_ID) }),
      });
      fx.push({ type: "state" });
      return { ok: true, effects: fx };
    }
    run.humanDecisions.pop();
    return { ok: false, error: `unknown human action: ${decision.action}`, effects: fx };
  }

  /**
   * A human note for `target` of session `sid` (default: active). Delivered now
   * if that agent is the one acting, else merged into its next delivery.
   */
  function humanMessage(target, text, sid = null) {
    fx = [];
    if (run.status !== "running") return { ok: false, error: `the run is ${run.status}`, effects: fx };
    if (target !== "researcher" && target !== "advisor") return { ok: false, error: `invalid target: ${target}`, effects: fx };
    const id = sid || activeId;
    const s = session(id);
    if (!s) return { ok: false, error: `unknown session: ${id}`, effects: fx };
    if (isTerminal(s.state)) return { ok: false, error: `session ${id} has finished`, effects: fx };
    if (id === activeId && STATE_ACTOR[s.state] === target) {
      deliver(target, id, { role: "human", kind: "human_message", text });
      return { ok: true, effects: fx };
    }
    defer(id, target, `[human note] ${text}`);
    return { ok: true, deferred: true, deferredUntil: id === activeId ? STATE_ACTOR[s.state] : `${id} resumes`, effects: fx };
  }

  // ---- run end ------------------------------------------------------------

  function finishRun(status, reason, ts) {
    run.status = status;
    run.finishedAt = ts;
    run.terminalReason = reason;
    fx.push({ type: "terminal", status, reason });
  }

  /** Abort the whole run (limits, crashes, the human stopping it). */
  function abortRun(reason, ts = Date.now()) {
    fx = [];
    if (run.status === "done" || run.status === "aborted") return { ok: false, error: `the run is ${run.status}`, effects: fx };
    for (const s of sessions.values()) {
      if (isTerminal(s.state)) continue;
      s.state = STATES.ABORTED;
      s.finishedAt = ts;
      s.terminalReason = reason;
      if (s.kind !== "skills") goals.abortPlanned(ownerOf(s), `not started: ${reason}`, ts);
    }
    for (const g of goals.byId.values()) {
      if (g.status === "in_progress") Object.assign(g, { status: "aborted", endReason: `aborted: ${reason}`, finishedAt: ts });
    }
    finishRun("aborted", reason, ts);
    return { ok: true, effects: fx };
  }

  // ---- resume / replay ----------------------------------------------------

  /**
   * Continue a replayed run in fresh agent processes: every live conversation
   * is marked lost, and the acting agent gets a re-orientation prompt.
   */
  function resume(extraText = "") {
    fx = [];
    if (run.status !== "running") return { ok: false, error: `the run is ${run.status}`, effects: fx };
    for (const s of sessions.values()) {
      if (isTerminal(s.state)) continue;
      for (const role of ["researcher", "advisor"]) stale.add(key(s.id, role));
    }
    const s = active();
    const actor = STATE_ACTOR[s.state];
    if (actor === "researcher" || actor === "advisor") {
      stale.delete(key(s.id, actor));
      const last = lastMessage.get(key(s.id, actor));
      prompt(
        actor,
        s.id,
        [
          "This run is being RESUMED after an interruption, in a FRESH container: anything installed",
          "outside /sandbox is gone, and your earlier conversation is lost. Files in /sandbox are",
          "preserved. Re-orient yourself (your system prompt, list_goals / read_goal, the sandbox),",
          "then continue from the current step; do not restart the task.",
          ...(last
            ? [
                "",
                "## The last message you were working on (repeated: your conversation was lost)",
                last.role === "control" ? last.text : renderInbound(last),
              ]
            : []),
          "",
          `## Current step (${s.kind} session ${s.id}, state ${s.state})`,
          instructionsFor(s),
          ...(extraText ? ["", "## Extra instructions from the human", extraText] : []),
        ].join("\n"),
        "start",
      );
    } else if (s.state === STATES.SKILLS_INSTALL) {
      for (const role of ["researcher", "advisor"]) {
        if (!skills.installed[role]) {
          deliver(role, s.id, { role: "control", kind: "install_skills", text: "", payload: { skills: skills.approved } });
        }
      }
    }
    fx.push({ type: "state" });
    return { ok: true, effects: fx };
  }

  /** Rebuild the model from control-plane log entries (effects are discarded). */
  function replay(entries) {
    for (const e of entries) {
      const ts = typeof e.ts === "number" ? e.ts : Date.now();
      if (e.kind === "start") {
        if (typeof e.skipSkills === "boolean") cfg.skipSkills = e.skipSkills;
        start(ts);
      }
      else if (e.kind === "handoff") {
        handoff(e.from, e.agentId || ROOT_ID, { kind: e.handoffKind, goalId: e.goalId ?? null, text: e.text || "", payload: e.payload || {} }, ts);
      } else if (e.kind === "skills_installed") skillsInstalled(e.from, e.payload || {}, ts);
      else if (e.kind === "human_decision") humanDecision({ action: e.action, text: e.text }, ts);
      else if (e.kind === "human_message") humanMessage(e.to, e.text || "", e.agentId || null);
    }
    fx = [];
    return snapshot();
  }

  // ---- queries ------------------------------------------------------------

  /** Correction prompt for an agent whose handoff was rejected. */
  function correction(role, sid, error) {
    fx = [];
    const s = session(sid) || active();
    if (!s) return { effects: fx };
    prompt(
      role,
      s.id,
      T.correctionText({
        error,
        state: s.state,
        kind: s.kind,
        allowed: STATE_ACTOR[s.state] === role ? allowedActions(s.kind, s.state) : [],
        instructions: STATE_ACTOR[s.state] === role ? instructionsFor(s) : "",
      }),
      "prompt",
      { correction: true },
    );
    return { effects: fx };
  }

  function snapshotSession(s) {
    const goal = s.goalId ? goals.get(s.goalId) : null;
    return {
      id: s.id,
      kind: s.kind,
      parentId: s.parentId,
      depth: s.depth,
      title: s.title,
      goalId: s.goalId,
      goalStatus: goal?.status || null,
      state: s.state,
      expecting: s.id === activeId ? STATE_ACTOR[s.state] : null,
      active: s.id === activeId,
      createdAt: s.createdAt,
      finishedAt: s.finishedAt,
      terminalReason: s.terminalReason,
      currentGoalId: s.kind === "main" || s.kind === "orchestrator" ? goals.current(ownerOf(s))?.id || null : s.goalId,
    };
  }

  function snapshot() {
    const root = session(ROOT_ID) || session(SKILLS_ID);
    const act = active();
    return {
      run: { ...run, humanDecisions: [...run.humanDecisions] },
      state: run.status === "done" ? STATES.DONE : run.status === "aborted" ? STATES.ABORTED : root?.state || "INIT",
      activeAgent: activeId,
      activeState: act?.state || null,
      activeKind: act?.kind || null,
      expecting: act ? STATE_ACTOR[act.state] : null,
      currentGoalId: act ? snapshotSession(act).currentGoalId : null,
      humanRequest: session(ROOT_ID)?.humanRequest || null,
      handoffs,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      terminalReason: run.terminalReason,
      humanDecisions: [...run.humanDecisions],
      agents: [...sessions.values()].map(snapshotSession),
    };
  }

  /** Goal lists of every planning session, in tree order (UI, goals.md). */
  function goalTree() {
    const out = [];
    const visit = (owner, depth) => {
      for (const g of goals.list(owner)) {
        out.push({ ...g, depth });
        const child = g.childId ? session(g.childId) : null;
        if (child?.kind === "orchestrator") visit(child.id, depth + 1);
      }
    };
    visit(ROOT_ID, 0);
    return out;
  }

  function renderGoalTree() {
    const tree = goalTree();
    if (!tree.length) return "(no plan has been accepted yet)";
    return tree
      .map((g) => `${"  ".repeat(g.depth)}${renderGoalList([g])}${g.childId ? ` (subagent ${g.childId})` : ""}`)
      .join("\n");
  }

  function goalDetail(id) {
    const goal = goals.get(str(id));
    return goal ? renderGoal(goal) : null;
  }

  function sessionInfo(id) {
    const s = session(id);
    if (!s) return null;
    return {
      ...snapshotSession(s),
      instructions: s.instructions,
      conditions: s.conditions,
      brief: s.brief,
      outcome: s.outcome,
      humanRequest: s.humanRequest,
      goals: s.kind === "main" || s.kind === "orchestrator" ? goals.snapshot(ownerOf(s)) : [],
      goal: s.goalId ? { ...goals.get(s.goalId) } : null,
    };
  }

  return {
    start,
    handoff,
    skillsInstalled,
    humanDecision,
    humanMessage,
    abortRun,
    resume,
    replay,
    correction,
    snapshot,
    goalTree,
    renderGoalTree,
    goalDetail,
    sessionInfo,
    activeId: () => activeId,
    expectedActor: (sid = activeId) => {
      const s = session(sid);
      return s ? STATE_ACTOR[s.state] : null;
    },
    isRunning: () => run.status === "running",
    run: () => ({ ...run }),
    skillNames: () => [...skills.names],
  };
}
