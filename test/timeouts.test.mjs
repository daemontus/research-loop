import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentSession } from "../agent/lib/agent-runner.mjs";

function makeSession(opts = {}) {
  return new AgentSession({
    role: "researcher",
    model: { id: "m", contextWindow: 0, maxTokens: 0 },
    models: { streamSimple: () => ({}) },
    systemPrompt: "",
    tools: [],
    sandbox: "/tmp",
    transcript: { write() {}, writeMessage() {}, close() {} },
    controlState: { pendingHandoff: null },
    ...opts,
  });
}

describe("optional timeouts", () => {
  it("disables all timeouts and uses a high turn cap by default", () => {
    const s = makeSession();
    assert.equal(s.abortTimeoutMs, 0, "per-attempt abort disabled by default");
    assert.equal(s.phaseTimeoutMs, 0, "hard phase budget disabled by default");
    assert.equal(s.maxTurnsPerPhase, 1000);
  });

  it("does not arm an abort timer when abortTimeoutMs is 0", () => {
    const s = makeSession({ abortTimeoutMs: 0 });
    assert.equal(s.abortTimeoutMs, 0);
    assert.equal(s.abortTimer, null);
  });

  it("accepts explicit timeout values", () => {
    const s = makeSession({ abortTimeoutMs: 1000, phaseTimeoutMs: 2000, maxTurnsPerPhase: 5 });
    assert.equal(s.abortTimeoutMs, 1000);
    assert.equal(s.phaseTimeoutMs, 2000);
    assert.equal(s.maxTurnsPerPhase, 5);
  });
});
