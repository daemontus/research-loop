import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bindControlTools, CONTROL_TOOL_DEFS, CONTROL_TOOLS_BY_KIND } from "../agent/lib/control-tools.mjs";
import { actionsForRole, NON_AGENT_ACTIONS, SESSION_KINDS, TRANSITIONS } from "../control-plane/state-machine.mjs";

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
    const tools = bindControlTools(CONTROL_TOOLS_BY_KIND.main.researcher, controller);
    const delegate = tools.find((t) => t.name === "propose_subagent");
    const proceed = tools.find((t) => t.name === "proceed");

    await delegate.execute("1", { goalId: "G1", mode: "full", instructions: "i", justification: "j" });
    assert.equal(controlState.pendingHandoff.kind, "propose_subagent");
    assert.equal(controlState.pendingHandoff.goalId, "G1");

    await assert.rejects(() => proceed.execute("2", { assessment: "a" }), /Only one control tool/);
    // The first handoff still stands.
    assert.equal(controlState.pendingHandoff.kind, "propose_subagent");
  });

  it("offers each role exactly the tools the state machine allows in its session kind", () => {
    for (const kind of SESSION_KINDS) {
      for (const role of ["researcher", "advisor"]) {
        assert.deepEqual(
          [...CONTROL_TOOLS_BY_KIND[kind][role]].sort(),
          [...actionsForRole(kind, role)].sort(),
          `${kind}/${role}`,
        );
      }
    }
  });

  it("defines a tool for every agent action, and nothing else", () => {
    const actions = new Set(TRANSITIONS.map((t) => t.action).filter((a) => !NON_AGENT_ACTIONS.has(a)));
    assert.deepEqual(Object.keys(CONTROL_TOOL_DEFS).sort(), [...actions].sort());
  });

  it("coordinating researchers cannot verify or implement; leaf researchers cannot delegate", () => {
    assert.ok(!CONTROL_TOOLS_BY_KIND.main.researcher.includes("submit_result"));
    assert.ok(!CONTROL_TOOLS_BY_KIND.leaf.researcher.includes("propose_subagent"));
    assert.ok(!CONTROL_TOOLS_BY_KIND.orchestrator.researcher.includes("propose_plan_change"));
  });

  it("keeps the non-blocking advisory field on review tools", () => {
    for (const name of ["approve_subagent", "accept_result", "request_result_changes", "accept_completion"]) {
      assert.ok(CONTROL_TOOL_DEFS[name].parameters.properties.advisory, name);
    }
  });
});
