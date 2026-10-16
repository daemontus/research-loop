/**
 * "Control tools" end an agent's phase and produce a handoff envelope.
 *
 * Calling any of these sets the controller's pending handoff; the runner's
 * `shouldStopAfterTurn` sees it, stops the agent loop, and forwards the
 * envelope to the peer via the broker.
 */
import { Type } from "typebox";

import { kindForTool } from "./protocol.mjs";

function strArray(description) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

const PLAN_TITLE = Type.String({ description: "Short goal title." });
const GOAL_ID = Type.String({
  description: "Stable goal id from GOALS.md, e.g. G1 or G2.1. Use 'TASK' for task-level.",
});
const PLAN_STEPS = Type.Array(Type.String(), {
  description: "Ordered, concrete plan steps for this goal.",
});
const ACCEPTANCE = Type.Array(Type.String(), {
  description: "Concrete, checkable acceptance criteria the advisor will verify.",
});
const SUMMARY = Type.String({ description: "Concise summary of what was done / decided." });
const FEEDBACK = Type.String({ description: "Short explanation for the researcher." });
const CHANGES = Type.Array(Type.String(), {
  description: "Specific, actionable required changes.",
});
const ADVISORY = Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Optional, non-blocking recommendations: higher-value directions, alternative " +
      "approaches, extra analyses. Fire-and-forget — the researcher may adopt or decline " +
      "them; they must NOT block acceptance.",
  }),
);

/** Tool definitions for the researcher role. */
export function researcherControlToolDefs() {
  return [
    {
      name: "propose_skills",
      label: "Propose Skills",
      kind: "skills_proposal",
      description:
        "First phase of the session. Search for reusable Agent Skills relevant to the broad " +
        "task (skills.sh via `npx skills find`, plus any skills already under /config/skills " +
        "and /sandbox/skills) and propose a set to install for this session. Hand off to the " +
        "advisor for approval. Call this before any planning. If no skill is genuinely " +
        "relevant, propose an empty list with `noneNeeded: true` and a justification.",
      parameters: Type.Object({
        summary: SUMMARY,
        noneNeeded: Type.Optional(
          Type.Boolean({
            description: "True only if no skill is relevant; explain why in `summary`.",
          }),
        ),
        skills: Type.Array(
          Type.Object({
            name: Type.String({ description: "Skill slug/name (e.g. 'tdd')." }),
            source: Type.String({
              description: "skills.sh source, e.g. 'owner/repo' or a full URL.",
            }),
            url: Type.Optional(Type.String({ description: "skills.sh page URL, if known." })),
            why: Type.String({ description: "Why this skill is relevant to the task." }),
            intendedUse: Type.Optional(
              Type.String({ description: "Which goals/steps you expect to apply it to." }),
            ),
          }),
          {
            description:
              "Candidate skills to install. May be empty when noneNeeded is true.",
          },
        ),
      }),
    },
    {
      name: "confirm_skills_installed",
      label: "Confirm Skills Installed",
      kind: "skills_ready",
      description:
        "After the advisor approves the skill set, install the approved skills into " +
        "/sandbox/skills (use the install_skill tool) and then call this to report exactly " +
        "what is installed. Only after this can you start planning. Report the installed " +
        "skill paths; this is verified against /sandbox/skills.",
      parameters: Type.Object({
        installed: Type.Array(
          Type.Object({
            name: Type.String({ description: "Installed skill name." }),
            path: Type.String({ description: "Path under /sandbox/skills/<name>/." }),
            source: Type.Optional(Type.String({ description: "Where it came from." })),
          }),
          { description: "The skills actually installed (empty if none were approved)." },
        ),
        notes: Type.Optional(Type.String({ description: "Anything the advisor should know." })),
      }),
    },
    {
      name: "submit_plan",
      label: "Submit Plan",
      kind: "proposal",
      description:
        "Submit (or revise) a plan for the current goal and hand off to the advisor for " +
        "review. Use this to add subgoals OR to fundamentally revise/replace the approach " +
        "when a goal turns out to be infeasible, under-specified, or better solved " +
        "differently. Always update GOALS.md first. You may call this again later to revise " +
        "the plan; set `revisionOf` to the previous plan/goal id and explain the change in " +
        "`rationale`. List in `skillsToUse` every installed skill the plan relies on and " +
        "make the plan steps reference them.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        title: PLAN_TITLE,
        plan: PLAN_STEPS,
        acceptanceCriteria: ACCEPTANCE,
        skillsToUse: strArray(
          "Names of installed skills this plan will apply. Must include every relevant " +
            "installed skill; the advisor will reject plans that ignore them.",
        ),
        parentGoal: Type.Optional(
          Type.String({ description: "Parent goal id when this is a subgoal (e.g. G2)." }),
        ),
        revisionOf: Type.Optional(
          Type.String({
            description: "Previous goal/plan id this proposal revises, if any (revision, not new subgoal).",
          }),
        ),
        rationale: Type.Optional(
          Type.String({
            description: "Why this plan (or revision) is the right next step / what changed.",
          }),
        ),
        subgoals: Type.Optional(
          Type.Array(
            Type.Object({
              goalId: Type.String({ description: "Subgoal id, e.g. G2.1." }),
              title: Type.String(),
              intent: Type.Optional(Type.String()),
            }),
            { description: "Optional decomposition of this goal into subgoals." },
          ),
        ),
      }),
    },
    {
      name: "submit_result",
      label: "Submit Result",
      kind: "result",
      description:
        "Hand a completed (or partial) result for the current approved goal to the advisor " +
        "for verification. Include exactly what you did, where the artifacts live (paths in " +
        "the sandbox), and the concrete verification you ran. Update GOALS.md status first.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        summary: SUMMARY,
        artifacts: strArray("Sandbox-relative paths of the produced artifacts."),
        verification: strArray(
          "Commands/tests/measurements you ran and their outcome (so the advisor can reproduce).",
        ),
        skillsUsed: strArray(
          "Names of installed skills you actually applied for this goal (with how). Required " +
            "whenever an installed skill is relevant; the advisor will reject results that " +
            "ignore a relevant skill.",
        ),
        blockers: strArray("Anything that blocked full completion, if any."),
        status: Type.Optional(
          Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("blocked")], {
            description: "Whether the goal is fully complete, partial, or blocked.",
          }),
        ),
      }),
    },
    {
      name: "request_task_completion",
      label: "Request Task Completion",
      kind: "task_request",
      description:
        "Ask the advisor to sign off that the whole research task is complete. Only after " +
        "every goal in GOALS.md is done (or explicitly abandoned with justification).",
      parameters: Type.Object({
        summary: SUMMARY,
        deliverables: strArray("Top-level deliverable paths (code, paper, results)."),
        unfinished: strArray("Any goals intentionally left unfinished, with reasons."),
      }),
    },
    {
      name: "propose_subagent",
      label: "Propose Subagent",
      kind: "subagent_proposal",
      description:
        "Propose delegating a self-contained subtask to a SUBAGENT: a fresh researcher/advisor " +
        "pair with its own context that works in your sandbox while you wait, and returns a " +
        "written report. The advisor must approve the proposal first (it may reject it with " +
        "feedback; then revise and propose again, or continue yourself). The subagent sees " +
        "nothing of your conversation: `instructions` must be complete and self-contained " +
        "(goal, context, relevant /sandbox paths, constraints, where to put outputs, what the " +
        "report must contain). Use it for well-scoped work that benefits from a clean context " +
        "(e.g. a focused investigation, an implementation, an experiment batch).",
      parameters: Type.Object({
        title: Type.String({ description: "Short name of the subtask." }),
        instructions: Type.String({
          description:
            "Complete, self-contained instructions for the subagent, written as a human would " +
            "brief a new collaborator.",
        }),
        goalId: Type.Optional(
          Type.String({ description: "Your goal id (from your GOALS.md) this subtask serves, if any." }),
        ),
        rationale: Type.String({
          description: "Why delegating this to a subagent is better than doing it yourself.",
        }),
        expectedOutputs: strArray("What the subagent must produce (files, findings, report content)."),
      }),
    },
  ];
}

/** Tool definitions for the advisor role. */
export function advisorControlToolDefs() {
  return [
    {
      name: "approve_skills",
      label: "Approve Skills",
      kind: "skills_approved",
      description:
        "Approve the skill set the researcher proposed to install (or an empty set if " +
        "`noneNeeded` is justified). Only approve skills you have checked are relevant and " +
        "safe (prefer audited, popular skills). The researcher will install them next.",
      parameters: Type.Object({
        feedback: FEEDBACK,
        conditions: strArray("Optional constraints on how the skills may be used."),
        advisory: ADVISORY,
      }),
    },
    {
      name: "request_skill_changes",
      label: "Request Skill Changes",
      kind: "skills_changes",
      description:
        "Send the skill proposal back: add/remove skills, or reject irrelevant/unsafe ones. " +
        "Be specific about what to change and why.",
      parameters: Type.Object({
        requiredChanges: CHANGES,
        feedback: FEEDBACK,
      }),
    },
    {
      name: "approve_plan",
      label: "Approve Plan",
      kind: "plan_approved",
      description:
        "Approve the researcher's proposed/revised plan so they can execute it. Give brief " +
        "directional feedback. Do not approve a plan you have not read against GOALS.md.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        feedback: FEEDBACK,
        conditions: strArray("Optional conditions the researcher must honor while executing."),
        advisory: ADVISORY,
      }),
    },
    {
      name: "request_plan_changes",
      label: "Request Plan Changes",
      kind: "plan_changes",
      description:
        "Reject or request changes to the proposed/revised plan. Be specific about what is " +
        "wrong (scope, feasibility, missing acceptance criteria, unsound method) and what to " +
        "change.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        requiredChanges: CHANGES,
        feedback: FEEDBACK,
        advisory: ADVISORY,
      }),
    },
    {
      name: "accept_result",
      label: "Accept Result",
      kind: "result_accepted",
      description:
        "Conclude that the current goal was met after independently verifying the result. " +
        "This is the only way a goal becomes 'done'. State what you verified and how.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        feedback: FEEDBACK,
        verification: strArray("How you verified the result (commands, files, checks)."),
        advisory: ADVISORY,
      }),
    },
    {
      name: "request_result_changes",
      label: "Request Result Changes",
      kind: "result_changes",
      description:
        "The goal is not met yet. Request specific changes, missing evidence, or fixes. The " +
        "researcher continues on the same goal.",
      parameters: Type.Object({
        goalId: GOAL_ID,
        requiredChanges: CHANGES,
        feedback: FEEDBACK,
        advisory: ADVISORY,
      }),
    },
    {
      name: "accept_task_completion",
      label: "Accept Task Completion",
      kind: "task_accepted",
      description:
        "Agree the whole research task is complete. This escalates to the human for final " +
        "approval; it does not end the session by itself.",
      parameters: Type.Object({
        summary: SUMMARY,
        feedback: FEEDBACK,
        caveats: strArray("Known limitations or follow-ups worth recording."),
      }),
    },
    {
      name: "request_task_changes",
      label: "Request Task Changes",
      kind: "task_changes",
      description:
        "The task is not complete. Send the researcher back to work with specific remaining " +
        "gaps.",
      parameters: Type.Object({
        requiredChanges: CHANGES,
        feedback: FEEDBACK,
        advisory: ADVISORY,
      }),
    },
    {
      name: "approve_subagent",
      label: "Approve Subagent",
      kind: "subagent_approved",
      description:
        "Approve the researcher's subagent proposal. The subagent starts immediately with the " +
        "proposed instructions (plus your `conditions`, which are appended to them); the " +
        "researcher and you wait until it reports back. Only approve a well-scoped, " +
        "self-contained subtask whose instructions a fresh agent could follow without the " +
        "conversation so far.",
      parameters: Type.Object({
        feedback: FEEDBACK,
        conditions: strArray("Optional constraints added to the subagent's instructions."),
        advisory: ADVISORY,
      }),
    },
    {
      name: "reject_subagent",
      label: "Reject Subagent",
      kind: "subagent_changes",
      description:
        "Reject the subagent proposal with feedback (unclear or incomplete instructions, poor " +
        "scope, better done directly, ...). The researcher may revise and propose again or " +
        "continue the work itself.",
      parameters: Type.Object({
        requiredChanges: CHANGES,
        feedback: FEEDBACK,
      }),
    },
  ];
}

/** Skills-phase control tools (not offered to subagents, which skip that phase). */
export const SKILLS_CONTROL_TOOLS = new Set([
  "propose_skills",
  "confirm_skills_installed",
  "approve_skills",
  "request_skill_changes",
]);

/**
 * Bind a set of control-tool definitions to a controller.
 *
 * @param {Array<object>} defs from researcherControlToolDefs()/advisorControlToolDefs()
 * @param {{ setHandoff: (h: object) => void }} controller
 */
const GOALLESS_TOOLS = new Set([
  "request_task_completion",
  "accept_task_completion",
  "propose_skills",
  "confirm_skills_installed",
  "approve_skills",
  "request_skill_changes",
  "approve_subagent",
  "reject_subagent",
]);

export function bindControlTools(defs, controller) {
  return defs.map((def) => ({
    ...def,
    execute: async (_id, params) => {
      const goalId =
        !GOALLESS_TOOLS.has(def.name) && params?.goalId ? String(params.goalId) : null;
      const accepted = controller.setHandoff({
        kind: kindForTool(def.name),
        goalId,
        payload: { ...params },
        toolName: def.name,
      });
      if (accepted === false) {
        // Exactly one control tool ends a phase. Refuse the extra call so the
        // turn stays deterministic (the first handoff stands).
        throw new Error(
          `Only one control tool may be called per turn. '${def.name}' was ignored; ` +
            "the session will proceed with the first handoff you submitted.",
        );
      }
      const message =
        `Handoff recorded (${kindForTool(def.name)}${goalId ? `, ${goalId}` : ""}). ` +
        "Your turn ends now; the peer will respond.";
      return { content: [{ type: "text", text: message }], details: {} };
    },
  }));
}
