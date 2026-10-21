/**
 * Texts the harness sends to agents: what to do in each state, child briefs,
 * and markdown renderings of handoff payloads. Pure functions of engine data.
 */
import { renderGoal, renderGoalList } from "./goal-store.mjs";

const bullets = (items) => (items || []).filter(Boolean).map((x) => `- ${x}`).join("\n");

/** How an agent should write goals (plans and subgoals). */
export const GOAL_WRITING_GUIDE = [
  "How to write goals:",
  "- Goals are worked on in order, each by a separate subagent with a fresh context that sees",
  "  only the goal, the parent's instructions, and the notes of earlier goals. Write every",
  "  description so that a different agent can act on it without this conversation.",
  "- Make each goal a meaningful unit of work (typically hours of focused work, many tool",
  "  calls), not a single step. Tightly coupled goals may share an id prefix to show it",
  "  (e.g. G1.1 plan the API survey, G1.2 run it).",
  "- Acceptance criteria are observable outcomes a reviewer can check: behaviour, artifacts,",
  "  measurements, evidence. Avoid proxies that can be satisfied without achieving the goal",
  "  (\"tests pass\" alone is not an outcome; say what must work). The reviewer judges the",
  "  goal by its description's intent; the criteria are the floor, not the whole bar.",
  "- `skills`: names of installed skills relevant to the goal (see the installed skills list).",
].join("\n");

export function skillsProposeText({ task, initialNote, preinstalled }) {
  return [
    "This is the SKILLS step: before the work starts, find Agent Skills that will help with the task.",
    "",
    "## The task (context)",
    task,
    ...(initialNote ? ["", initialNote] : []),
    "",
    "## What to do",
    "1. Inspect the skills already available: /sandbox/skills and /config/skills.",
    preinstalled.length ? `   Already installed: ${preinstalled.join(", ")}.` : "   No skills are installed yet.",
    "2. Search skills.sh for reusable skills relevant to this task (`npx skills find <query>`),",
    "   and check candidates for relevance, popularity and security audits.",
    "3. Call propose_skills with the set to install (source exactly as skills.sh shows it, plus",
    "   the skill name within the source when it holds several), or `noneNeeded: true` with a",
    "   justification. You do not install anything yourself: once the advisor approves, the",
    "   harness installs the skills for both agents.",
  ].join("\n");
}

export const SKILLS_REVIEW_TEXT = [
  "Review the proposed skills: are they relevant to the task, popular/audited, and safe to",
  "install? Call approve_skills (optionally with conditions on their use) or",
  "request_skill_changes with what to add, remove or replace. If the researcher says none are",
  "needed, approve only a justified `noneNeeded`.",
].join("\n");

export function planDraftText({ task, initialNote, installedSkills }) {
  return [
    "You are starting the MAIN session. Break the task below into an ordered list of goals and",
    "submit it with propose_plan. The researcher will review the plan for organisation and",
    "clarity, and then delegate each goal, in order, to subagents. You approve every delegation",
    "and every later plan change.",
    "",
    "## The task",
    task,
    ...(initialNote ? ["", initialNote] : []),
    "",
    installedSkills.length ? `Installed skills: ${installedSkills.join(", ")}.` : "No skills are installed.",
    "",
    GOAL_WRITING_GUIDE,
    "",
    "Inspect the workspace first (/researcher-sandbox holds the researcher's files, including any",
    "provided resources) so the goals fit what is actually there.",
  ].join("\n");
}

export const PLAN_REVIEW_TEXT = [
  "Review the advisor's plan above. You will delegate each goal to a subagent, so check above all",
  "the organisation and clarity of the work: is the order sensible, are the goals well scoped",
  "and distinct, is each description specific enough for an agent who sees only that goal, and",
  "are the acceptance criteria real outcomes? Do not reject it over feasibility unless something",
  "is clearly impossible. Call accept_plan, or request_plan_changes with specific changes.",
].join("\n");

export function prepareText({ goal, splitAllowed, depthNote, kind }) {
  return [
    `Prepare a subagent for the next goal, ${goal.id}. Goals are worked on in order; you do not`,
    `implement anything yourself in a${kind === "main" ? " main" : "n orchestrator"} session.`,
    "",
    renderGoal(goal, { withOutcome: false }),
    "",
    "Call propose_subagent with this goalId and either:",
    "- `mode: \"full\"`: one subagent implements the whole goal; or",
    splitAllowed
      ? "- `mode: \"split\"` with `subgoals` (ids starting with the goal id): the subagent becomes an orchestrator that delegates each subgoal in turn."
      : `- (splitting into subgoals is not available here: ${depthNote})`,
    "`instructions` are what the subagent gets besides the goal itself: context and decisions it",
    "needs, relevant paths, constraints, pitfalls. Notes of earlier goals are passed on",
    "automatically. `justification` must explain the scope decision: why this goal is one sensible",
    "unit of work, or why splitting it is worth the overhead (each subagent starts from scratch).",
    "Prefer `full` unless the goal is clearly too large or has distinct phases.",
  ].join("\n");
}

export function subagentReviewText({ goal, splitAllowed }) {
  return [
    `Review the researcher's delegation of goal ${goal.id} (above). Focus on scope: is the goal a`,
    "sensible single unit of work, or would a split be justified (or is a proposed split",
    "unnecessary overhead)? Are the instructions complete and self-contained for an agent that",
    "sees nothing of this conversation? Are subgoals, if any, well formed goals with real",
    "acceptance criteria?",
    splitAllowed ? null : "(Splitting is not available at this depth: the goal must be delegated in full.)",
    "",
    renderGoal(goal, { withOutcome: false }),
    "",
    "Call approve_subagent (optionally adding `conditions` the subagent must honour) or",
    "reject_subagent with specific required changes.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** What the researcher may do in reflection. */
export function reflectOptions({ kind, nextGoal }) {
  const lines = ["Decide how to continue:"];
  if (nextGoal) lines.push(`- proceed: continue with the next goal, ${nextGoal.id} (${nextGoal.title}).`);
  if (kind === "main") {
    lines.push("- propose_plan_change: replace all goals that are still planned with a new list (the advisor signs off).");
  }
  if (!nextGoal) {
    lines.push(
      kind === "main"
        ? "- finish_session: all goals are worked through; give the human a summary and notes."
        : "- finish_session: all subgoals are worked through; your advisor then checks that your goal is met.",
    );
  }
  lines.push(
    kind === "main"
      ? "- abort_session: stop the task (the human confirms)."
      : "- abort_session: end this session as aborted with a proposal; your parent re-plans. Use it when the remaining subgoals no longer make sense.",
  );
  return lines.join("\n");
}

export function reflectText({ kind, child, goal, nextGoal }) {
  const done = child.state === "DONE";
  return [
    `[subagent ${child.id} ${done ? "finished" : "aborted"}] goal ${goal.id}: ${goal.title}`,
    "",
    renderGoal(goal),
    "",
    "REFLECT: is everything going according to plan, given this outcome? Check the outcome",
    "against the goal (you can inspect files read-only), and whether the remaining goals still make",
    "sense.",
    "",
    reflectOptions({ kind, nextGoal }),
  ].join("\n");
}

export function advisorChildSummary({ child, goal }) {
  return [
    `[subagent ${child.id} ${child.state === "DONE" ? "finished" : "aborted"}] goal ${goal.id} (${goal.title}).`,
    goal.endReason ? `Outcome: ${goal.endReason}` : null,
    goal.verdict ? `Its advisor's verdict: ${goal.verdict}` : null,
    "Use read_goal for its full report.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planChangeReviewText({ currentList }) {
  return [
    "The researcher proposes to replace every goal that is still planned with the list above.",
    "Done, aborted and in-progress goals are not affected. Current goals:",
    currentList,
    "",
    "Judge whether the change is justified by what happened so far and whether the new goals are",
    "well formed. Call approve_plan_change or reject_plan_change.",
  ].join("\n");
}

export function finalCheckText({ goal, subgoals }) {
  return [
    `All subgoals of ${goal.id} are worked through. FINAL CHECK: is the goal itself met, as a whole?`,
    "Each subgoal was verified on its own; check that together they achieve the goal's",
    "description and acceptance criteria (integration, consistency, nothing missing). Inspect the",
    "artifacts yourself.",
    "",
    renderGoal(goal, { withOutcome: false }),
    "",
    "Subgoals:",
    subgoals,
    "",
    "Call accept_completion, or reject_completion with the reasons (the session then ends as",
    "aborted and the parent re-plans).",
  ].join("\n");
}

export const WORK_TEXT = [
  "Work on your goal (see your system prompt). When it is achieved, call submit_result with a",
  "report for your parent (what you did, where the artifacts are, how you verified it,",
  "deviations) and notes for later agents (gotchas, environment facts, things you wish you had",
  "known). If the goal turns out infeasible or far larger than expected, call request_abort with",
  "the reason, a report and a proposal instead.",
].join("\n");

export function resultReviewText({ goal }) {
  return [
    `Verify the result for goal ${goal.id}. Inspect the artifacts and reproduce the verification`,
    "where it matters. The goal is met when its description's intent is achieved and the",
    "acceptance criteria hold; check also that the report and notes are accurate.",
    "",
    renderGoal(goal, { withOutcome: false }),
    "",
    "Call accept_result (with what you verified) or request_result_changes.",
  ].join("\n");
}

export const ABORT_REVIEW_TEXT = [
  "The researcher asks to abort this goal (above). Confirm only if continuing is genuinely not",
  "worthwhile (infeasible, or far beyond the goal's intended scope); otherwise reject with",
  "guidance on how to proceed. Call confirm_abort or reject_abort.",
].join("\n");

/** Fresh-context brief of a child session (goes into both agents' system prompts). */
export function childBrief({ child, goal, chain, siblings, subgoals }) {
  const lines = [
    `## Your goal (${child.kind === "leaf" ? "implement it" : "orchestrate it through its subgoals"})`,
    renderGoal(goal, { withOutcome: false }),
    "",
  ];
  if (chain.length) {
    lines.push("## Where it fits", ...chain.map((g, i) => `${"  ".repeat(i)}- ${g.id} — ${g.title}`), "");
  }
  if (child.instructions) lines.push("## Instructions from the parent researcher", child.instructions, "");
  if (child.conditions?.length) lines.push("## Conditions from the approving advisor", bullets(child.conditions), "");
  if (subgoals?.length) lines.push("## Your subgoals (in order)", renderGoalList(subgoals), "");
  if (siblings.length) {
    lines.push("## Earlier goals at this level (outcome and notes)");
    for (const s of siblings) {
      lines.push(`### ${s.id} — ${s.title} [${s.status}]`);
      if (s.endReason) lines.push(`Outcome: ${s.endReason}`);
      lines.push(s.notes ? `Notes:\n${s.notes}` : "Notes: (none)", "");
    }
    lines.push("Use read_goal <id> for an earlier goal's full report.", "");
  }
  return lines.join("\n").trim();
}

export function correctionText({ error, state, kind, allowed, instructions }) {
  return [
    `Your last handoff was rejected by the harness: ${error}.`,
    "",
    `This ${kind} session is in state ${state}; call one of: ${allowed.map((a) => `\`${a}\``).join(", ") || "(none)"}.`,
    ...(instructions ? ["", instructions] : []),
  ].join("\n");
}

/** Markdown rendering of a handoff payload for the receiving agent. */
export function renderPayload(kind, p = {}) {
  const out = [];
  const add = (title, value) => {
    if (Array.isArray(value) ? value.length : value) {
      out.push(`**${title}**`, Array.isArray(value) ? bullets(value) : String(value), "");
    }
  };
  switch (kind) {
    case "propose_skills":
      add("Summary", p.summary);
      if (p.noneNeeded) out.push("(no skills needed)", "");
      for (const s of p.skills || []) {
        out.push(`- ${s.name} (${s.source}${s.skill ? `, skill ${s.skill}` : ""}): ${s.why || ""}`);
      }
      break;
    case "propose_plan":
    case "propose_plan_change":
      add("Rationale", p.rationale);
      out.push(...(p.goals || []).map((g) => renderGoal({ status: "planned", acceptance: [], skills: [], ...g }, { withOutcome: false })), "");
      break;
    case "propose_subagent":
      out.push(`Goal ${p.goalId}, mode: ${p.mode}`, "");
      add("Justification", p.justification);
      add("Instructions", p.instructions);
      for (const g of p.subgoals || []) {
        out.push(renderGoal({ status: "planned", acceptance: [], skills: [], ...g }, { withOutcome: false }), "");
      }
      break;
    case "submit_result":
      add("Summary", p.summary);
      add("Artifacts", p.artifacts);
      add("Verification", p.verification);
      add("Report", p.report);
      add("Notes for later agents", p.notes);
      break;
    case "request_abort":
    case "abort_session":
      add("Reason", p.reason);
      add("Proposal", p.proposal);
      add("Report", p.report);
      add("Notes", p.notes);
      break;
    case "finish_session":
      add("Summary", p.summary);
      add("Report", p.report);
      add("Notes", p.notes);
      break;
    default:
      add("Feedback", p.feedback);
      add("Required changes", p.requiredChanges);
      add("Conditions", p.conditions);
      add("Verification", p.verification);
      add("Assessment", p.assessment);
      add("Recommendations (non-blocking)", p.advisory);
  }
  return out.join("\n").trim();
}
