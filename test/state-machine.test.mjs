import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actionsForRole,
  allowedActions,
  INITIAL_STATE,
  isTerminal,
  nextState,
  SESSION_KINDS,
  STATE_ACTOR,
  STATES,
  TRANSITIONS,
} from "../control-plane/state-machine.mjs";

describe("state machine structure", () => {
  it("every state of every session kind is reachable and (unless terminal) has a way out", () => {
    for (const kind of SESSION_KINDS) {
      const edges = TRANSITIONS.filter((t) => t.kinds.includes(kind));
      const reachable = new Set([INITIAL_STATE[kind]]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of edges) {
          if (reachable.has(t.from) && !reachable.has(t.to)) {
            reachable.add(t.to);
            grew = true;
          }
        }
      }
      for (const state of new Set(edges.flatMap((t) => [t.from, t.to]))) {
        assert.ok(reachable.has(state), `${kind}: ${state} is unreachable`);
        if (!isTerminal(state)) {
          assert.ok(edges.some((t) => t.from === state), `${kind}: ${state} is a dead end`);
        }
      }
      assert.ok(reachable.has(STATES.DONE), `${kind} can finish`);
    }
  });

  it("every state names its actor, and agents act only in their own states", () => {
    for (const t of TRANSITIONS) {
      assert.ok(t.from in STATE_ACTOR, `${t.from} has an actor`);
      assert.ok(t.to in STATE_ACTOR, `${t.to} has an actor`);
    }
    assert.deepEqual(allowedActions("main", STATES.PLAN_DRAFT), ["propose_plan"]);
    assert.equal(STATE_ACTOR.PLAN_DRAFT, "advisor", "the advisor writes the main plan");
    assert.deepEqual(allowedActions("main", STATES.CHILD_RUNNING), [], "nobody acts while a child runs");
    assert.deepEqual(allowedActions("main", STATES.AWAITING_HUMAN), [], "only the human decides");
  });

  it("orchestrators cannot change their plan; only leaves submit results", () => {
    assert.ok(!actionsForRole("orchestrator", "researcher").includes("propose_plan_change"));
    assert.ok(actionsForRole("main", "researcher").includes("propose_plan_change"));
    assert.deepEqual(actionsForRole("leaf", "researcher").sort(), ["request_abort", "submit_result"]);
    for (const kind of ["main", "orchestrator", "skills"]) {
      assert.ok(!actionsForRole(kind, "researcher").includes("submit_result"), kind);
    }
  });

  it("resolves conditional targets", () => {
    assert.deepEqual(nextState("main", STATES.PLAN_CHANGE_REVIEW, "approve_plan_change", "planned goals left"), { to: STATES.GOAL_PREPARE });
    assert.deepEqual(nextState("main", STATES.PLAN_CHANGE_REVIEW, "approve_plan_change", "no planned goals left"), { to: STATES.REFLECT });
    assert.deepEqual(nextState("main", STATES.REFLECT, "finish_session", "no planned goals left"), { to: STATES.AWAITING_HUMAN });
    assert.deepEqual(nextState("orchestrator", STATES.REFLECT, "finish_session", "no planned goals left"), { to: STATES.FINAL_CHECK });
    assert.deepEqual(nextState("orchestrator", STATES.REFLECT, "abort_session"), { to: STATES.ABORTED });
    assert.deepEqual(nextState("main", STATES.AWAITING_HUMAN, "human_approve", "abort requested"), { to: STATES.ABORTED });
  });

  it("refuses actions that are not allowed in the current state", () => {
    const r = nextState("leaf", STATES.WORK, "accept_result");
    assert.match(r.error, /not allowed in state WORK of a leaf session; expected one of: submit_result, request_abort/);
  });
});
