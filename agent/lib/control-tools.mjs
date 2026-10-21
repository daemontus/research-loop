/**
 * "Control tools" end an agent's turn and produce a handoff envelope whose
 * `kind` is the tool's name. Which tool is allowed when is decided by the
 * control plane's state machine (control-plane/state-machine.mjs); this module
 * defines the tools and which session kind/role is offered which of them.
 */
import { Type } from "typebox";

const text = (description) => Type.String({ description });
const optText = (description) => Type.Optional(Type.String({ description }));
const list = (description) => Type.Array(Type.String(), { description });
const optList = (description) => Type.Optional(Type.Array(Type.String(), { description }));

const FEEDBACK = text("Short explanation for the other agent.");
const REQUIRED_CHANGES = list("Specific, actionable changes that are required.");
const ADVISORY = optList(
  "Optional, non-blocking recommendations (better directions, extra checks). They never block; the researcher may adopt or decline them.",
);

const GOAL = Type.Object({
  id: Type.String({
    description:
      "Unique goal id (letters, digits, '.', '_', '-'). Ids may show closeness (G1.1, G1.2); subgoals must start with their goal's id and a dot.",
  }),
  title: Type.String({ description: "One-line title." }),
  description: Type.String({
    description: "Markdown description, specific enough for a different agent who sees only this goal.",
  }),
  acceptance: Type.Array(Type.String(), {
    description: "Observable outcomes a reviewer can check (not proxies such as 'tests pass').",
  }),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Installed skills relevant to this goal." })),
});
const GOALS = (description) => Type.Array(GOAL, { description });

/** Every control tool: name -> { label, description, parameters }. */
export const CONTROL_TOOL_DEFS = {
  // --- skills session ---
  propose_skills: {
    label: "Propose Skills",
    description:
      "Propose the Agent Skills to install for this task (found on skills.sh with `npx skills find`). " +
      "The advisor reviews the set; once approved, the harness installs them for both agents. If no " +
      "skill is relevant, propose an empty list with `noneNeeded: true` and explain why in `summary`.",
    parameters: Type.Object({
      summary: text("Why these skills (or why none)."),
      noneNeeded: Type.Optional(Type.Boolean({ description: "True only when no skill is relevant." })),
      skills: Type.Array(
        Type.Object({
          name: Type.String({ description: "Skill name." }),
          source: Type.String({ description: "skills.sh source exactly as shown there, e.g. owner/repo." }),
          skill: Type.Optional(Type.String({ description: "Skill name within the source, when it holds several." })),
          why: Type.String({ description: "Why it is relevant to the task." }),
        }),
        { description: "Skills to install (empty when noneNeeded)." },
      ),
    }),
  },
  approve_skills: {
    label: "Approve Skills",
    description: "Approve the proposed skills; the harness then installs them for both agents.",
    parameters: Type.Object({ feedback: FEEDBACK, conditions: optList("Constraints on how the skills may be used.") }),
  },
  request_skill_changes: {
    label: "Request Skill Changes",
    description: "Send the skill proposal back with what to add, remove or replace.",
    parameters: Type.Object({ requiredChanges: REQUIRED_CHANGES, feedback: FEEDBACK }),
  },

  // --- main session: planning ---
  propose_plan: {
    label: "Propose Plan",
    description:
      "Submit the ordered list of goals for the task. The researcher reviews it; once accepted, each goal is " +
      "delegated to a subagent in order. Goals are tracked by the harness (there is no goals file).",
    parameters: Type.Object({
      goals: GOALS("The goals, in the order they will be worked on."),
      rationale: text("Why the work is organised this way."),
    }),
  },
  accept_plan: {
    label: "Accept Plan",
    description: "Accept the advisor's plan. You then delegate its first goal.",
    parameters: Type.Object({ feedback: FEEDBACK }),
  },
  request_plan_changes: {
    label: "Request Plan Changes",
    description: "Send the plan back to the advisor with specific changes (organisation, clarity, scope).",
    parameters: Type.Object({ requiredChanges: REQUIRED_CHANGES, feedback: FEEDBACK }),
  },

  // --- goal loop (main + orchestrator) ---
  propose_subagent: {
    label: "Propose Subagent",
    description:
      "Delegate the next goal to a subagent (a fresh researcher/advisor pair). `mode: \"full\"`: it implements " +
      "the goal. `mode: \"split\"`: it works through `subgoals` (ids starting with the goal id), delegating each " +
      "in turn. The advisor approves or rejects the delegation.",
    parameters: Type.Object({
      goalId: Type.String({ description: "The next goal (goals are worked on in order)." }),
      mode: Type.Union([Type.Literal("full"), Type.Literal("split")], {
        description: "full = one subagent implements the goal; split = it orchestrates the subgoals.",
      }),
      instructions: text(
        "What the subagent needs besides the goal: context and decisions, relevant paths, constraints, pitfalls.",
      ),
      justification: text("Why this scope: why the goal is one sensible unit of work, or why splitting it pays off."),
      subgoals: Type.Optional(GOALS("Only with mode split: the subgoals, in order (at least two).")),
    }),
  },
  approve_subagent: {
    label: "Approve Subagent",
    description: "Approve the delegation; the subagent starts immediately. `conditions` are added to its brief.",
    parameters: Type.Object({
      feedback: FEEDBACK,
      conditions: optList("Constraints the subagent must honour."),
      advisory: ADVISORY,
    }),
  },
  reject_subagent: {
    label: "Reject Subagent",
    description: "Reject the delegation (scope, unclear instructions, poorly formed subgoals) with required changes.",
    parameters: Type.Object({ requiredChanges: REQUIRED_CHANGES, feedback: FEEDBACK }),
  },
  proceed: {
    label: "Proceed",
    description: "After reflecting on the last subagent's outcome: continue with the next planned goal.",
    parameters: Type.Object({ assessment: text("Brief assessment of the outcome and why the plan still holds.") }),
  },
  propose_plan_change: {
    label: "Propose Plan Change",
    description:
      "Main session only, during reflection: replace ALL goals that are still planned with a new list (done, " +
      "aborted and in-progress goals stay). The advisor approves or rejects it. An empty list removes the " +
      "remaining goals.",
    parameters: Type.Object({
      goals: GOALS("The new remaining goals, in order."),
      rationale: text("What changed and why the plan must change."),
    }),
  },
  approve_plan_change: {
    label: "Approve Plan Change",
    description: "Approve the proposed plan change.",
    parameters: Type.Object({ feedback: FEEDBACK }),
  },
  reject_plan_change: {
    label: "Reject Plan Change",
    description: "Reject the proposed plan change; the researcher reflects again.",
    parameters: Type.Object({ feedback: FEEDBACK, requiredChanges: optList("What would make a change acceptable.") }),
  },
  finish_session: {
    label: "Finish Session",
    description:
      "When no planned goals are left. Main session: ask the human to approve completion, with a `summary` for " +
      "the human and `notes`. Orchestrator: hand the result to your advisor's final check, with a `report` for " +
      "the parent and `notes` for later agents.",
    parameters: Type.Object({
      summary: optText("Main session: summary for the human."),
      report: optText("Orchestrator: report for the parent (what was achieved, evidence, deviations)."),
      notes: optText("Notes for later agents (gotchas, environment facts)."),
    }),
  },
  abort_session: {
    label: "Abort Session",
    description:
      "Stop this session. Main session: the human confirms. Orchestrator: the session ends as aborted and the " +
      "parent re-plans; give a `proposal` for how it should continue.",
    parameters: Type.Object({
      reason: text("Why the session should stop."),
      proposal: optText("What the parent should do instead."),
      report: optText("What was achieved so far."),
      notes: optText("Notes for later agents."),
    }),
  },
  accept_completion: {
    label: "Accept Completion",
    description: "Final check passed: the session's goal is met as a whole.",
    parameters: Type.Object({ feedback: FEEDBACK, verification: optList("What you checked."), advisory: ADVISORY }),
  },
  reject_completion: {
    label: "Reject Completion",
    description: "Final check failed: the goal is not met as a whole. The session ends as aborted and the parent re-plans.",
    parameters: Type.Object({ requiredChanges: REQUIRED_CHANGES, feedback: FEEDBACK }),
  },

  // --- leaf session ---
  submit_result: {
    label: "Submit Result",
    description: "Hand the achieved goal to the advisor for verification.",
    parameters: Type.Object({
      summary: text("What was done."),
      report: text("Report for the parent: what was achieved, where the artifacts are, how it was verified, deviations."),
      notes: text("Notes for later agents: gotchas, environment facts, things you wish you had known."),
      artifacts: optList("Sandbox paths of the produced artifacts."),
      verification: optList("Commands/checks you ran and their outcome, so the advisor can reproduce them."),
    }),
  },
  request_result_changes: {
    label: "Request Result Changes",
    description: "The goal is not met yet: request specific changes or missing evidence.",
    parameters: Type.Object({ requiredChanges: REQUIRED_CHANGES, feedback: FEEDBACK, advisory: ADVISORY }),
  },
  accept_result: {
    label: "Accept Result",
    description: "The goal is met: you verified it independently. This ends the session.",
    parameters: Type.Object({
      feedback: FEEDBACK,
      verification: list("How you verified the result (commands, files, checks)."),
      advisory: ADVISORY,
    }),
  },
  request_abort: {
    label: "Request Abort",
    description: "The goal is infeasible or far larger than expected: ask the advisor to end this session as aborted.",
    parameters: Type.Object({
      reason: text("Why the goal cannot be completed as specified."),
      report: text("What was achieved and learned so far."),
      proposal: optText("How the parent should continue instead."),
      notes: optText("Notes for later agents."),
    }),
  },
  confirm_abort: {
    label: "Confirm Abort",
    description: "Agree that the goal should be aborted. This ends the session.",
    parameters: Type.Object({ feedback: FEEDBACK }),
  },
  reject_abort: {
    label: "Reject Abort",
    description: "Disagree: the researcher continues working on the goal.",
    parameters: Type.Object({ feedback: FEEDBACK }),
  },
};

/** Control tools offered to each role, by session kind (mirrors the state machine; checked by a test). */
export const CONTROL_TOOLS_BY_KIND = {
  skills: {
    researcher: ["propose_skills"],
    advisor: ["request_skill_changes", "approve_skills"],
  },
  main: {
    researcher: ["request_plan_changes", "accept_plan", "propose_subagent", "proceed", "propose_plan_change", "finish_session", "abort_session"],
    advisor: ["propose_plan", "reject_subagent", "approve_subagent", "reject_plan_change", "approve_plan_change"],
  },
  orchestrator: {
    researcher: ["propose_subagent", "proceed", "finish_session", "abort_session"],
    advisor: ["reject_subagent", "approve_subagent", "accept_completion", "reject_completion"],
  },
  leaf: {
    researcher: ["submit_result", "request_abort"],
    advisor: ["request_result_changes", "accept_result", "reject_abort", "confirm_abort"],
  },
};

/**
 * Bind control tools to a controller. Calling one records the handoff; the
 * runner stops the agent loop after the turn and forwards it.
 * @param {string[]} names
 * @param {{ setHandoff: (h: object) => boolean }} controller
 */
export function bindControlTools(names, controller) {
  return names.map((name) => {
    const def = CONTROL_TOOL_DEFS[name];
    if (!def) throw new Error(`unknown control tool: ${name}`);
    return {
      name,
      ...def,
      execute: async (_id, params) => {
        const goalId = typeof params?.goalId === "string" ? params.goalId : null;
        const accepted = controller.setHandoff({ kind: name, goalId, payload: { ...params }, toolName: name });
        if (accepted === false) {
          // Exactly one control tool ends a turn; the first one stands.
          throw new Error(
            `Only one control tool may be called per turn. '${name}' was ignored; the first handoff you submitted stands.`,
          );
        }
        return {
          content: [{ type: "text", text: `Handoff recorded (${name}${goalId ? `, ${goalId}` : ""}). Your turn ends now.` }],
          details: {},
        };
      },
    };
  });
}
