/**
 * Session state machines of the research-loop protocol (see docs/PROTOCOL.md).
 *
 * Declarative and pure: which actor acts in each state, which control tools
 * (actions) it may call there, and where each action leads. The engine
 * (engine.mjs) validates payloads and applies side effects; this module only
 * answers "is this transition legal, and where does it go".
 *
 * Some transitions have two possible targets that depend on the goal store
 * (e.g. an approved plan change leads to GOAL_PREPARE when goals are left,
 * else to REFLECT); those are listed with a `when` condition and resolved by
 * the engine through `nextState(..., facts)`.
 */

export const SESSION_KINDS = ["skills", "main", "orchestrator", "leaf"];

export const STATES = {
  // skills session
  SKILLS_PROPOSE: "SKILLS_PROPOSE",
  SKILLS_REVIEW: "SKILLS_REVIEW",
  SKILLS_INSTALL: "SKILLS_INSTALL",
  // main session: planning
  PLAN_DRAFT: "PLAN_DRAFT",
  PLAN_REVIEW: "PLAN_REVIEW",
  // main + orchestrator: goal loop
  GOAL_PREPARE: "GOAL_PREPARE",
  SUBAGENT_REVIEW: "SUBAGENT_REVIEW",
  CHILD_RUNNING: "CHILD_RUNNING",
  REFLECT: "REFLECT",
  PLAN_CHANGE_REVIEW: "PLAN_CHANGE_REVIEW",
  FINAL_CHECK: "FINAL_CHECK",
  AWAITING_HUMAN: "AWAITING_HUMAN",
  // leaf session
  WORK: "WORK",
  RESULT_REVIEW: "RESULT_REVIEW",
  ABORT_REVIEW: "ABORT_REVIEW",
  // terminal
  DONE: "DONE",
  ABORTED: "ABORTED",
};

/** Who must act in each state: an agent role, the harness, the human, or nobody. */
export const STATE_ACTOR = {
  SKILLS_PROPOSE: "researcher",
  SKILLS_REVIEW: "advisor",
  SKILLS_INSTALL: "harness",
  PLAN_DRAFT: "advisor",
  PLAN_REVIEW: "researcher",
  GOAL_PREPARE: "researcher",
  SUBAGENT_REVIEW: "advisor",
  CHILD_RUNNING: "harness",
  REFLECT: "researcher",
  PLAN_CHANGE_REVIEW: "advisor",
  FINAL_CHECK: "advisor",
  AWAITING_HUMAN: "human",
  WORK: "researcher",
  RESULT_REVIEW: "advisor",
  ABORT_REVIEW: "advisor",
  DONE: null,
  ABORTED: null,
};

/** First state of each session kind. */
export const INITIAL_STATE = {
  skills: STATES.SKILLS_PROPOSE,
  main: STATES.PLAN_DRAFT,
  orchestrator: STATES.GOAL_PREPARE,
  leaf: STATES.WORK,
};

const S = STATES;
const ALL_LOOP = ["main", "orchestrator"];

/**
 * Every legal transition. `kinds`: session kinds it applies to; `action`: the
 * control tool (or harness/human event) that triggers it; `when`: a condition
 * on engine facts when one action has several targets.
 */
export const TRANSITIONS = [
  { kinds: ["skills"], from: S.SKILLS_PROPOSE, action: "propose_skills", to: S.SKILLS_REVIEW },
  { kinds: ["skills"], from: S.SKILLS_REVIEW, action: "request_skill_changes", to: S.SKILLS_PROPOSE },
  { kinds: ["skills"], from: S.SKILLS_REVIEW, action: "approve_skills", to: S.SKILLS_INSTALL, when: "skills to install" },
  { kinds: ["skills"], from: S.SKILLS_REVIEW, action: "approve_skills", to: S.DONE, when: "nothing to install" },
  { kinds: ["skills"], from: S.SKILLS_INSTALL, action: "skills_installed", to: S.DONE, when: "both sandboxes installed" },

  { kinds: ["main"], from: S.PLAN_DRAFT, action: "propose_plan", to: S.PLAN_REVIEW },
  { kinds: ["main"], from: S.PLAN_REVIEW, action: "request_plan_changes", to: S.PLAN_DRAFT },
  { kinds: ["main"], from: S.PLAN_REVIEW, action: "accept_plan", to: S.GOAL_PREPARE },

  { kinds: ALL_LOOP, from: S.GOAL_PREPARE, action: "propose_subagent", to: S.SUBAGENT_REVIEW },
  { kinds: ALL_LOOP, from: S.SUBAGENT_REVIEW, action: "reject_subagent", to: S.GOAL_PREPARE, when: "below rejection cap" },
  { kinds: ["main"], from: S.SUBAGENT_REVIEW, action: "reject_subagent", to: S.AWAITING_HUMAN, when: "rejection cap reached" },
  { kinds: ["orchestrator"], from: S.SUBAGENT_REVIEW, action: "reject_subagent", to: S.ABORTED, when: "rejection cap reached" },
  { kinds: ALL_LOOP, from: S.SUBAGENT_REVIEW, action: "approve_subagent", to: S.CHILD_RUNNING },
  { kinds: ALL_LOOP, from: S.CHILD_RUNNING, action: "child_ended", to: S.REFLECT },

  { kinds: ALL_LOOP, from: S.REFLECT, action: "proceed", to: S.GOAL_PREPARE, when: "planned goals left" },
  { kinds: ["main"], from: S.REFLECT, action: "propose_plan_change", to: S.PLAN_CHANGE_REVIEW },
  { kinds: ["main"], from: S.REFLECT, action: "finish_session", to: S.AWAITING_HUMAN, when: "no planned goals left" },
  { kinds: ["main"], from: S.REFLECT, action: "abort_session", to: S.AWAITING_HUMAN },
  { kinds: ["orchestrator"], from: S.REFLECT, action: "finish_session", to: S.FINAL_CHECK, when: "no planned goals left" },
  { kinds: ["orchestrator"], from: S.REFLECT, action: "abort_session", to: S.ABORTED },

  { kinds: ["main"], from: S.PLAN_CHANGE_REVIEW, action: "reject_plan_change", to: S.REFLECT },
  { kinds: ["main"], from: S.PLAN_CHANGE_REVIEW, action: "approve_plan_change", to: S.GOAL_PREPARE, when: "planned goals left" },
  { kinds: ["main"], from: S.PLAN_CHANGE_REVIEW, action: "approve_plan_change", to: S.REFLECT, when: "no planned goals left" },

  { kinds: ["orchestrator"], from: S.FINAL_CHECK, action: "accept_completion", to: S.DONE },
  { kinds: ["orchestrator"], from: S.FINAL_CHECK, action: "reject_completion", to: S.ABORTED },

  { kinds: ["main"], from: S.AWAITING_HUMAN, action: "human_approve", to: S.DONE, when: "completion requested" },
  { kinds: ["main"], from: S.AWAITING_HUMAN, action: "human_approve", to: S.ABORTED, when: "abort requested" },
  { kinds: ["main"], from: S.AWAITING_HUMAN, action: "human_reject", to: S.REFLECT },

  { kinds: ["leaf"], from: S.WORK, action: "submit_result", to: S.RESULT_REVIEW },
  { kinds: ["leaf"], from: S.WORK, action: "request_abort", to: S.ABORT_REVIEW },
  { kinds: ["leaf"], from: S.RESULT_REVIEW, action: "request_result_changes", to: S.WORK },
  { kinds: ["leaf"], from: S.RESULT_REVIEW, action: "accept_result", to: S.DONE },
  { kinds: ["leaf"], from: S.ABORT_REVIEW, action: "reject_abort", to: S.WORK },
  { kinds: ["leaf"], from: S.ABORT_REVIEW, action: "confirm_abort", to: S.ABORTED },
];

/** Actions that are not agent control tools. */
export const NON_AGENT_ACTIONS = new Set(["skills_installed", "child_ended", "human_approve", "human_reject"]);

/** Control tools an agent may call in `state` of a `kind` session. */
export function allowedActions(kind, state) {
  const out = [];
  for (const t of TRANSITIONS) {
    if (t.from !== state || !t.kinds.includes(kind) || NON_AGENT_ACTIONS.has(t.action)) continue;
    if (!out.includes(t.action)) out.push(t.action);
  }
  return out;
}

/** Every control tool `role` can ever call in a `kind` session. */
export function actionsForRole(kind, role) {
  const out = [];
  for (const t of TRANSITIONS) {
    if (!t.kinds.includes(kind) || NON_AGENT_ACTIONS.has(t.action)) continue;
    if (STATE_ACTOR[t.from] !== role || out.includes(t.action)) continue;
    out.push(t.action);
  }
  return out;
}

/**
 * Target state of `action` from `state`, or an error. `when` picks among
 * conditional targets: pass the condition label that holds (see TRANSITIONS).
 * @returns {{ to: string } | { error: string }}
 */
export function nextState(kind, state, action, when = null) {
  const candidates = TRANSITIONS.filter((t) => t.from === state && t.action === action && t.kinds.includes(kind));
  if (!candidates.length) {
    const allowed = allowedActions(kind, state);
    return {
      error:
        `'${action}' is not allowed in state ${state} of a ${kind} session` +
        (allowed.length ? `; expected one of: ${allowed.join(", ")}` : ""),
    };
  }
  if (candidates.length === 1 && !when) return { to: candidates[0].to };
  const match = candidates.find((t) => t.when === when);
  if (match) return { to: match.to };
  if (candidates.length === 1) return { to: candidates[0].to };
  throw new Error(`ambiguous transition ${kind}/${state}/${action} (when=${when})`);
}

export function isTerminal(state) {
  return state === STATES.DONE || state === STATES.ABORTED;
}

const ACTOR_LABEL = { researcher: "R", advisor: "A", harness: "harness", human: "human" };

/** Markdown transition table (embedded in docs/PROTOCOL.md). */
export function renderTransitionTable() {
  const rows = [
    "| Session | From | Actor | Action | To | When |",
    "|---|---|---|---|---|---|",
  ];
  for (const t of TRANSITIONS) {
    rows.push(
      `| ${t.kinds.join(", ")} | ${t.from} | ${ACTOR_LABEL[STATE_ACTOR[t.from]] || "-"} | \`${t.action}\` | ${t.to} | ${t.when || ""} |`,
    );
  }
  return rows.join("\n");
}
