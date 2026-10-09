import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTROL_TOOL_NAMES,
  isAdvisorKind,
  isResearcherKind,
  kindForTool,
  renderInbound,
  validateEnvelope,
} from "../agent/lib/protocol.mjs";

describe("protocol: tool <-> kind mapping", () => {
  it("maps researcher control tools", () => {
    assert.equal(kindForTool("submit_plan"), "proposal");
    assert.equal(kindForTool("submit_result"), "result");
    assert.equal(kindForTool("request_task_completion"), "task_request");
    assert.equal(isResearcherKind("proposal"), true);
    assert.equal(isAdvisorKind("proposal"), false);
  });

  it("maps advisor control tools", () => {
    assert.equal(kindForTool("approve_plan"), "plan_approved");
    assert.equal(kindForTool("accept_result"), "result_accepted");
    assert.equal(kindForTool("task_accepted"), null); // not a tool name
    assert.equal(kindForTool("accept_task_completion"), "task_accepted");
    assert.equal(isAdvisorKind("result_accepted"), true);
  });

  it("recognizes only real control tool names", () => {
    assert.equal(CONTROL_TOOL_NAMES.has("submit_plan"), true);
    assert.equal(CONTROL_TOOL_NAMES.has("bash"), false);
  });
});

describe("protocol: validateEnvelope", () => {
  const base = { role: "researcher", kind: "proposal", goalId: "G1", text: "hi", payload: {} };

  it("accepts a valid envelope", () => {
    assert.equal(validateEnvelope(base).ok, true);
  });

  it("accepts a null goal id", () => {
    assert.equal(validateEnvelope({ ...base, goalId: null }).ok, true);
  });

  it("rejects bad role/kind/text", () => {
    assert.equal(validateEnvelope({ ...base, role: "nobody" }).ok, false);
    assert.equal(validateEnvelope({ ...base, kind: "nonsense" }).ok, false);
    assert.equal(validateEnvelope({ ...base, text: 5 }).ok, false);
    assert.equal(validateEnvelope(null).ok, false);
  });

  it("accepts control-plane envelopes", () => {
    assert.equal(validateEnvelope({ role: "control", kind: "start", text: "go" }).ok, true);
  });
});

describe("protocol: renderInbound", () => {
  it("renders header, text, payload, and goals snapshot", () => {
    const out = renderInbound(
      {
        role: "researcher",
        kind: "result",
        goalId: "G2",
        text: "Implemented and tested.",
        payload: { summary: "ok", artifacts: ["src/a.rs"] },
      },
      { goalsSnapshot: "### G2 [status: in_progress]" },
    );
    assert.ok(out.includes("handoff from researcher | kind=result | goal=G2"));
    assert.ok(out.includes("Implemented and tested."));
    assert.ok(out.includes('"artifacts"'));
    assert.ok(out.includes("current GOALS.md"));
    assert.ok(out.includes("G2 [status: in_progress]"));
  });
});
