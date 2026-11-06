import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";

import { bindControlTools, CONTROL_TOOLS_BY_KIND } from "../agent/lib/control-tools.mjs";
import { closeUnbalancedJson, withJsonArgRecovery } from "../agent/lib/json-args.mjs";

const controller = { setHandoff: () => true };
const advisorTools = bindControlTools(CONTROL_TOOLS_BY_KIND.main.advisor, controller).map((t) =>
  withJsonArgRecovery(t),
);
const proposePlan = advisorTools.find((t) => t.name === "propose_plan");

/** Run the tool call through the same steps as pi-agent-core: prepare, then validate. */
function prepareAndValidate(tool, args) {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return validateToolArguments(tool, { type: "toolCall", id: "1", name: tool.name, arguments: prepared });
}

const goal = { id: "G1", title: "t", description: "d", acceptance: ["a", "b"] };

describe("json-args recovery", () => {
  it("replays the real advisor failure: stringified goals missing the final ']'", () => {
    const args = JSON.parse(
      fs.readFileSync(new URL("./fixtures/stringified-goals-missing-bracket.json", import.meta.url), "utf8"),
    );
    assert.equal(typeof args.goals, "string");
    // Without the hook pi-ai rejects it with the unhelpful "goals.0: must be object".
    assert.throws(() => validateToolArguments(proposePlan, { name: "propose_plan", arguments: args }), /goals\.0/);
    const out = prepareAndValidate(proposePlan, args);
    assert.ok(Array.isArray(out.goals));
    assert.equal(out.goals[0].id, "G1");
    assert.ok(out.goals[0].description.includes("β"));
  });

  it("parses a well-formed stringified array", () => {
    const out = prepareAndValidate(proposePlan, { rationale: "r", goals: JSON.stringify([goal, { ...goal, id: "G2" }]) });
    assert.deepEqual(out.goals.map((g) => g.id), ["G1", "G2"]);
  });

  it("leaves proper arrays untouched", () => {
    const args = { rationale: "r", goals: [goal] };
    assert.equal(proposePlan.prepareArguments(args), args);
  });

  it("gives an actionable error for unrecoverable strings", () => {
    assert.throws(
      () => proposePlan.prepareArguments({ rationale: "r", goals: '[{"id": "G1", "title": "unterminated' }),
      /Parameter "goals" of propose_plan must be a JSON array.*not a size limit/s,
    );
    assert.throws(() => proposePlan.prepareArguments({ rationale: "r", goals: '{"id": "G1"}' }), /wrong type/);
  });

  it("does not attach a hook to tools without structured parameters", () => {
    const accept = bindControlTools(["accept_plan"], controller)[0];
    assert.equal(withJsonArgRecovery(accept).prepareArguments, undefined);
  });

  it("closes only plain truncations", () => {
    assert.equal(closeUnbalancedJson('[{"a": ["x]"]}'), '[{"a": ["x]"]}]');
    assert.equal(closeUnbalancedJson('[{"a": 1]'), null); // mismatched closer
    assert.equal(closeUnbalancedJson('[{"a": "open'), null); // unterminated string
    assert.equal(closeUnbalancedJson("[1]"), null); // nothing to close
  });
});
