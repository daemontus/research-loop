import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker, readSessionLog } from "../control-plane/broker.mjs";

describe("broker control log", () => {
  it("lives outside the agent mounts and keeps event kinds apart from envelope kinds", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-log-"));
    const broker = createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true });
    broker.register("advisor");
    broker.start();

    const goals = [{ id: "G1", title: "t", description: "d", acceptance: ["a"] }];
    const res = broker.receiveAgentEnvelope("advisor", {
      role: "advisor",
      kind: "propose_plan",
      goalId: null,
      text: "plan",
      payload: { goals, rationale: "r" },
      ts: Date.now(),
    });
    assert.equal(res.ok, true);

    assert.ok(fs.existsSync(path.join(tmp, "control", "session.jsonl")));
    assert.ok(!fs.existsSync(path.join(tmp, "transcripts", "session.jsonl")), "not in the agents' transcript mount");
    const entries = readSessionLog(tmp);
    const handoff = entries.find((e) => e.kind === "handoff");
    assert.equal(handoff.handoffKind, "propose_plan");
    assert.equal(handoff.agent, "control");
    assert.deepEqual(handoff.payload.goals, goals);

    const deliver = entries.find((e) => e.kind === "deliver" && e.to === "researcher");
    assert.equal(deliver.deliverKind, "propose_plan");
    // No entry's kind should have been clobbered by the envelope kind.
    assert.equal(entries.filter((e) => e.kind === "propose_plan").length, 0);
  });

  it("replays into the same run (resume)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-replay-"));
    const broker = createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true });
    broker.start();
    const goals = [{ id: "G1", title: "t", description: "d", acceptance: ["a"] }];
    broker.receiveAgentEnvelope("advisor", { role: "advisor", kind: "propose_plan", text: "", payload: { goals }, ts: 1 });
    broker.receiveAgentEnvelope("researcher", { role: "researcher", kind: "accept_plan", text: "", payload: {}, ts: 2 });
    broker.humanMessage("advisor", "be strict");

    const resumed = createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, replayEntries: readSessionLog(tmp) });
    assert.equal(resumed.snapshot().activeState, "GOAL_PREPARE");
    assert.deepEqual(resumed.goalTree().goals.map((g) => g.id), ["G1"]);
    const r = resumed.resume("carry on");
    assert.equal(r.ok, true);
    assert.equal(r.expecting, "researcher");
    // The held human note survives the restart and reaches the advisor's next delivery.
    resumed.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "propose_subagent",
      goalId: "G1",
      text: "",
      payload: { goalId: "G1", mode: "full", instructions: "i", justification: "j" },
      ts: 3,
    });
    return resumed.poll("advisor", 0, 50).then((batch) => {
      const handoff = batch.messages.find((m) => m.kind === "propose_subagent");
      assert.match(handoff.text, /\[human note\] be strict/);
      assert.match(handoff.text, /RESUMED/);
    });
  });
});
