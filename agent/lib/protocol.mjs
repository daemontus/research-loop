/**
 * Handoff protocol shared by the agent runner, control plane, and UI.
 *
 * A handoff is an envelope:
 *   {
 *     role: "researcher" | "advisor" | "human",
 *     kind: <one of the *_KINDS below>,
 *     goalId: string | null,
 *     text: string,        // the sender's final assistant text
 *     payload: object,     // structured control-tool arguments
 *     ts: number,
 *     seq: number          // assigned by the control plane
 *   }
 */

export const RESEARCHER_KINDS = [
  "skills_proposal",
  "skills_ready",
  "proposal",
  "result",
  "task_request",
];
export const ADVISOR_KINDS = [
  "skills_approved",
  "skills_changes",
  "plan_approved",
  "plan_changes",
  "result_accepted",
  "result_changes",
  "task_accepted",
  "task_changes",
];
export const HUMAN_KINDS = ["human_message", "human_decision"];
export const CONTROL_KINDS = ["start", "prompt", "session_done", "abort"];

export const ALL_KINDS = new Set([
  ...RESEARCHER_KINDS,
  ...ADVISOR_KINDS,
  ...HUMAN_KINDS,
  ...CONTROL_KINDS,
]);

/** Control tool name -> handoff kind. */
export const TOOL_TO_KIND = {
  propose_skills: "skills_proposal",
  confirm_skills_installed: "skills_ready",
  approve_skills: "skills_approved",
  request_skill_changes: "skills_changes",
  submit_plan: "proposal",
  submit_result: "result",
  request_task_completion: "task_request",
  approve_plan: "plan_approved",
  request_plan_changes: "plan_changes",
  accept_result: "result_accepted",
  request_result_changes: "result_changes",
  accept_task_completion: "task_accepted",
  request_task_changes: "task_changes",
};

export const CONTROL_TOOL_NAMES = new Set(Object.keys(TOOL_TO_KIND));

export function kindForTool(toolName) {
  return TOOL_TO_KIND[toolName] || null;
}

export function isResearcherKind(kind) {
  return RESEARCHER_KINDS.includes(kind);
}

export function isAdvisorKind(kind) {
  return ADVISOR_KINDS.includes(kind);
}

/**
 * Validate a handoff envelope produced by an agent runner.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: "envelope must be an object" };
  }
  if (
    envelope.role !== "researcher" &&
    envelope.role !== "advisor" &&
    envelope.role !== "human" &&
    envelope.role !== "control"
  ) {
    return { ok: false, error: `invalid role: ${envelope.role}` };
  }
  if (!ALL_KINDS.has(envelope.kind)) {
    return { ok: false, error: `invalid kind: ${envelope.kind}` };
  }
  if (envelope.goalId != null && typeof envelope.goalId !== "string") {
    return { ok: false, error: "goalId must be a string or null" };
  }
  if (typeof envelope.text !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  return { ok: true };
}

function bulletize(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(Boolean).map((x) => `  - ${typeof x === "string" ? x : JSON.stringify(x)}`);
}

/**
 * Render an inbound envelope into the user prompt handed to the receiving agent.
 * @param {object} envelope
 * @param {object} [opts]
 * @param {string} [opts.goalsSnapshot] current GOALS.md content (researcher->advisor or vice versa)
 * @param {string} [opts.skillsSnapshot] index of installed skills available in the sandbox
 */
export function renderInbound(envelope, { goalsSnapshot = "", skillsSnapshot = "" } = {}) {
  const lines = [
    `[handoff from ${envelope.role} | kind=${envelope.kind}` +
      `${envelope.goalId ? ` | goal=${envelope.goalId}` : ""}]`,
    "",
  ];
  if (envelope.text && envelope.text.trim()) {
    lines.push(envelope.text.trim(), "");
  }
  lines.push("--- structured payload ---");
  lines.push(JSON.stringify(envelope.payload ?? {}, null, 2));
  if (skillsSnapshot && skillsSnapshot.trim()) {
    lines.push("", "--- installed skills ---", skillsSnapshot.trim());
  }
  if (goalsSnapshot && goalsSnapshot.trim()) {
    lines.push("", "--- current GOALS.md ---", goalsSnapshot.trim());
  }
  return lines.join("\n");
}

/**
 * Human-readable label for a kind (used by the WebUI timeline).
 */
export function kindLabel(kind) {
  const labels = {
    skills_proposal: "Skills proposed",
    skills_ready: "Skills installed",
    skills_approved: "Skills approved",
    skills_changes: "Skill changes requested",
    proposal: "Plan proposed",
    result: "Result submitted",
    task_request: "Task completion requested",
    plan_approved: "Plan approved",
    plan_changes: "Plan changes requested",
    result_accepted: "Result accepted (goal met)",
    result_changes: "Result changes requested",
    task_accepted: "Task completion accepted",
    task_changes: "Task completion changes requested",
    human_message: "Human message",
    human_decision: "Human decision",
  };
  return labels[kind] || kind;
}
