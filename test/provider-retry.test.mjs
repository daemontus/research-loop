import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentSession } from "../agent/lib/agent-runner.mjs";

function makeSession(opts = {}) {
  const calls = [];
  const models = {
    streamSimple: (model, context, options) => {
      calls.push(options);
      return {};
    },
  };
  const transcript = { write() {}, writeMessage() {}, close() {} };
  const session = new AgentSession({
    role: "researcher",
    model: { id: "m", contextWindow: 0, maxTokens: 0 },
    models,
    systemPrompt: "",
    tools: [],
    sandbox: "/tmp",
    transcript,
    controlState: { pendingHandoff: null },
    ...opts,
  });
  return { session, calls };
}

describe("provider retry policy injection", () => {
  it("defaults maxRetries/maxRetryDelayMs into streamSimple", () => {
    const { session, calls } = makeSession();
    const agent = session.makeAgent();
    agent.streamFunction({ id: "m" }, {}, undefined);
    assert.equal(calls[0].maxRetries, 2);
    assert.equal(calls[0].maxRetryDelayMs, 60000);
  });

  it("lets an explicit per-call option win", () => {
    const { session, calls } = makeSession();
    const agent = session.makeAgent();
    agent.streamFunction({ id: "m" }, {}, { maxRetries: 1, maxRetryDelayMs: 5 });
    assert.equal(calls[0].maxRetries, 1);
    assert.equal(calls[0].maxRetryDelayMs, 5);
  });

  it("honors configured retry counts", () => {
    const { session, calls } = makeSession({ maxProviderRetries: 7, maxRetryDelayMs: 1234 });
    const agent = session.makeAgent();
    agent.streamFunction({ id: "m" }, {}, undefined);
    assert.equal(calls[0].maxRetries, 7);
    assert.equal(calls[0].maxRetryDelayMs, 1234);
  });
});
