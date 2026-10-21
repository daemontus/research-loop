/**
 * Read-only goal tools. Goals live in the control plane (they are not files),
 * so these ask the broker; they never end the agent's turn.
 */
import { Type } from "typebox";

/** @param {{ goals: () => Promise<object>, goal: (id: string) => Promise<object> }} broker */
export function makeGoalTools(broker) {
  return [
    {
      name: "list_goals",
      label: "List Goals",
      description:
        "Show the run's goal tree with statuses ([ ] planned, [~] in progress, [x] done, [-] aborted) and which subagent worked on each goal.",
      parameters: Type.Object({}),
      execute: async () => {
        const res = await broker.goals();
        return { content: [{ type: "text", text: res?.markdown || "(no goals yet)" }], details: {} };
      },
    },
    {
      name: "read_goal",
      label: "Read Goal",
      description:
        "Show one goal in full: description, acceptance criteria, skills, and once it is finished the subagent's report, notes and the advisor's verdict.",
      parameters: Type.Object({ id: Type.String({ description: "Goal id, e.g. G2.1." }) }),
      execute: async (_id, params) => {
        const res = await broker.goal(String(params?.id || ""));
        if (!res?.ok) throw new Error(res?.error || `unknown goal id: ${params?.id}`);
        return { content: [{ type: "text", text: res.goal }], details: {} };
      },
    },
  ];
}
