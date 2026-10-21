import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONTROL_TOOL_NAMES, renderInbound, validateEnvelope } from "../agent/lib/protocol.mjs";

describe("protocol: kinds", () => {
  it("envelope kinds are control tool names", () => {
    assert.equal(CONTROL_TOOL_NAMES.has("propose_plan"), true);
    assert.equal(CONTROL_TOOL_NAMES.has("submit_result"), true);
    assert.equal(CONTROL_TOOL_NAMES.has("bash"), false);
    assert.equal(CONTROL_TOOL_NAMES.has("submit_plan"), false, "the old protocol's tools are gone");
  });
});

describe("protocol: validateEnvelope", () => {
  const base = { role: "researcher", kind: "submit_result", goalId: null, text: "hi", payload: {} };

  it("accepts a valid envelope", () => {
    assert.equal(validateEnvelope(base).ok, true);
    assert.equal(validateEnvelope({ ...base, kind: "propose_subagent", goalId: "G1" }).ok, true);
  });

  it("rejects bad role/kind/text", () => {
    assert.equal(validateEnvelope({ ...base, role: "nobody" }).ok, false);
    assert.equal(validateEnvelope({ ...base, kind: "proposal" }).ok, false);
    assert.equal(validateEnvelope({ ...base, text: 5 }).ok, false);
    assert.equal(validateEnvelope(null).ok, false);
  });

  it("accepts control-plane and installer envelopes", () => {
    assert.equal(validateEnvelope({ role: "control", kind: "start", text: "go" }).ok, true);
    assert.equal(validateEnvelope({ role: "control", kind: "install_skills", text: "" }).ok, true);
    assert.equal(validateEnvelope({ role: "advisor", kind: "skills_installed", text: "" }).ok, true);
  });
});

describe("protocol: renderInbound", () => {
  it("renders header, text, the harness-rendered body and the next step", () => {
    const out = renderInbound({
      role: "researcher",
      kind: "submit_result",
      goalId: null,
      agentId: "S3",
      text: "Implemented and tested.",
      payload: { summary: "ok" },
      body: "**Report**\nAll done.",
      next: "Verify the result.",
    });
    assert.match(out, /^\[handoff from researcher \| submit_result \| session=S3\]/);
    assert.match(out, /Implemented and tested\./);
    assert.match(out, /\*\*Report\*\*\nAll done\./);
    assert.doesNotMatch(out, /structured payload/, "the body replaces the raw payload");
    assert.match(out, /--- what to do now ---\nVerify the result\./);
  });

  it("falls back to the raw payload without a body", () => {
    const out = renderInbound({ role: "advisor", kind: "accept_plan", text: "", payload: { feedback: "ok" } });
    assert.match(out, /--- structured payload ---/);
    assert.match(out, /"feedback": "ok"/);
  });

  it("labels human messages", () => {
    const out = renderInbound({ role: "human", kind: "human_message", text: "hello" });
    assert.match(out, /^\[message from the human \| human_message\]/);
  });
});
