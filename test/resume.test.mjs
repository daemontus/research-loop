import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker, readSessionLog } from "../control-plane/broker.mjs";

const env = (role, kind, payload = {}, agentId = "root") => ({ role, kind, goalId: payload.goalId ?? null, text: "", payload, ts: Date.now(), agentId });
const GOALS = [{ id: "G1", title: "t", description: "d", acceptance: ["a"] }];

function runUntil(steps) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-resume-"));
  const broker = createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true });
  broker.start();
  for (const [role, kind, payload, agentId] of steps) {
    const r = broker.receiveAgentEnvelope(role, env(role, kind, payload, agentId));
    assert.equal(r.ok, true, `${kind}: ${r.error}`);
  }
  return { tmp, broker, resumed: () => createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, replayEntries: readSessionLog(tmp) }) };
}

const TO_LEAF = [
  ["advisor", "propose_plan", { goals: GOALS }],
  ["researcher", "accept_plan", {}],
  ["researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "i", justification: "j" }],
  ["advisor", "approve_subagent", {}],
];

describe("resume", () => {
  it("continues inside the subagent that was working, with a re-orientation prompt", async () => {
    const { resumed } = runUntil(TO_LEAF);
    const broker = resumed();
    const r = broker.resume("mind the tests");
    assert.equal(r.agentId, "S1");
    assert.equal(r.expecting, "researcher");
    const [prompt] = (await broker.poll("researcher", 0, 50)).messages;
    assert.equal(prompt.agentId, "S1");
    assert.equal(prompt.agent.kind, "leaf");
    assert.match(prompt.agent.brief, /G1 — t/, "the fresh context gets the brief again");
    assert.match(prompt.text, /RESUMED[\s\S]*state WORK[\s\S]*mind the tests/);
    // Work continues normally afterwards.
    assert.equal(broker.receiveAgentEnvelope("researcher", env("researcher", "submit_result", { report: "r" }, "S1")).ok, true);
  });

  it("repeats the last message the agent was working on (e.g. the advisor's required changes)", async () => {
    const { tmp, broker: live, resumed } = runUntil([
      ...TO_LEAF,
      ["researcher", "submit_result", { report: "first try" }, "S1"],
      ["advisor", "request_result_changes", { requiredChanges: ["Grade Step 3 per scenario"], feedback: "incomplete" }, "S1"],
    ]);
    // A correction after that must not replace it as "the last message".
    live.receiveAgentEnvelope("researcher", env("researcher", "proceed", {}, "S1"));
    const broker = resumed();
    broker.resume();
    const [prompt] = (await broker.poll("researcher", 0, 50)).messages;
    assert.match(prompt.text, /The last message you were working on[\s\S]*request_result_changes[\s\S]*Grade Step 3 per scenario/);
    assert.match(prompt.text, /## Current step \(leaf session S1, state WORK\)/);
    assert.ok(tmp);
  });

  it("delivers nothing to agents while the human is to decide", async () => {
    const { resumed } = runUntil([
      ...TO_LEAF,
      ["researcher", "submit_result", { report: "r" }, "S1"],
      ["advisor", "accept_result", {}, "S1"],
      ["researcher", "finish_session", { summary: "done" }],
    ]);
    const broker = resumed();
    assert.equal(broker.snapshot().state, "AWAITING_HUMAN");
    const r = broker.resume();
    assert.equal(r.expecting, "human");
    for (const role of ["researcher", "advisor"]) {
      assert.equal((await broker.poll(role, 0, 50)).messages.length, 0, role);
    }
    assert.equal(broker.humanDecision({ action: "approve" }).ok, true);
    assert.equal(broker.snapshot().state, "DONE");
  });
});
