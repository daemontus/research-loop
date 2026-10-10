import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindControlTools,
  advisorControlToolDefs,
  researcherControlToolDefs,
} from "../agent/lib/control-tools.mjs";

function makeController() {
  const controlState = { pendingHandoff: null };
  return {
    controlState,
    controller: {
      setHandoff: (h) => {
        if (controlState.pendingHandoff) return false;
        controlState.pendingHandoff = h;
        return true;
      },
    },
  };
}

describe("control tools", () => {
  it("accepts exactly one control tool and rejects a second in the same turn", async () => {
    const { controlState, controller } = makeController();
    const tools = bindControlTools(researcherControlToolDefs(), controller);
    const submitPlan = tools.find((t) => t.name === "submit_plan");
    const submitResult = tools.find((t) => t.name === "submit_result");

    await submitPlan.execute("1", {
      goalId: "G1",
      title: "t",
      plan: ["a"],
      acceptanceCriteria: ["b"],
    });
    assert.equal(controlState.pendingHandoff.kind, "proposal");

    await assert.rejects(
      () => submitResult.execute("2", { goalId: "G1", summary: "s" }),
      /Only one control tool/,
    );
    // The first handoff still stands.
    assert.equal(controlState.pendingHandoff.kind, "proposal");
  });

  it("exposes an optional advisory field on the review tools (non-blocking)", () => {
    const advisoryKeys = (defs) => {
      const out = {};
      for (const def of defs) {
        const schema = def.parameters?.properties || {};
        out[def.name] = Boolean(schema.advisory);
      }
      return out;
    };
    const advisor = advisoryKeys(advisorControlToolDefs());
    assert.equal(advisor.approve_skills, true);
    assert.equal(advisor.approve_plan, true);
    assert.equal(advisor.request_plan_changes, true);
    assert.equal(advisor.accept_result, true);
    assert.equal(advisor.request_result_changes, true);
    assert.equal(advisor.request_task_changes, true);
  });
});
