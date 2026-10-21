import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker } from "../control-plane/broker.mjs";

function newBroker(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-"));
  return { tmp, broker: createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, ...opts }) };
}
const env = (role, kind, payload = {}, agentId = "root") => ({ role, kind, goalId: null, text: "", payload, ts: Date.now(), agentId });
const GOALS = [{ id: "G1", title: "t", description: "d", acceptance: ["a"] }];

describe("broker human-message routing", () => {
  it("delivers a note to the agent whose turn it is", async () => {
    const { broker } = newBroker();
    broker.start(); // the advisor plans
    const r = broker.humanMessage("advisor", "keep it to three goals");
    assert.equal(r.ok, true);
    assert.equal(r.deferred, false);
    const msgs = (await broker.poll("advisor", 0, 50)).messages;
    assert.ok(msgs.some((m) => m.kind === "human_message" && m.text === "keep it to three goals"));
  });

  it("holds a note for the other agent and merges it into its next handoff", async () => {
    const { broker } = newBroker();
    broker.start();
    const r = broker.humanMessage("researcher", "check the order carefully");
    assert.equal(r.deferred, true);
    assert.equal(r.deferredUntil, "advisor");
    assert.equal((await broker.poll("researcher", 0, 50)).messages.length, 0);
    broker.receiveAgentEnvelope("advisor", env("advisor", "propose_plan", { goals: GOALS }));
    const msgs = (await broker.poll("researcher", 0, 50)).messages;
    assert.match(msgs[0].text, /^\[human note\] check the order carefully/);
  });

  it("refuses notes once the run is over", () => {
    const { broker } = newBroker();
    broker.start();
    broker.abort("stop");
    assert.equal(broker.humanMessage("researcher", "hello").ok, false);
  });
});

describe("broker handoff cap", () => {
  it("aborts the run once the accepted handoffs reach --max-handoffs", () => {
    const { broker } = newBroker({ maxHandoffs: 2 });
    broker.start();
    broker.receiveAgentEnvelope("advisor", env("advisor", "propose_plan", { goals: GOALS }));
    assert.equal(broker.snapshot().state, "PLAN_REVIEW");
    broker.receiveAgentEnvelope("researcher", env("researcher", "accept_plan"));
    assert.equal(broker.snapshot().state, "ABORTED");
    assert.match(broker.snapshot().terminalReason, /max handoffs reached \(2\)/);
  });
});

describe("broker skills phase", () => {
  it("asks both agent processes to install the approved skills and starts the main session after both acks", async () => {
    const { broker, tmp } = newBroker({ skipSkills: false });
    broker.start();
    assert.equal(broker.snapshot().activeAgent, "skills");
    assert.equal(
      broker.receiveAgentEnvelope(
        "researcher",
        env("researcher", "propose_skills", { summary: "s", skills: [{ name: "tdd", source: "o/r", why: "w" }] }, "skills"),
      ).ok,
      true,
    );
    broker.receiveAgentEnvelope("advisor", env("advisor", "approve_skills", { feedback: "ok" }, "skills"));
    for (const role of ["researcher", "advisor"]) {
      const msgs = (await broker.poll(role, 0, 50)).messages;
      const install = msgs.find((m) => m.kind === "install_skills");
      assert.deepEqual(install.payload.skills.map((s) => s.source), ["o/r"], role);
    }
    // An ack while nothing is pending, or a model trying to fake one, changes nothing.
    assert.equal(broker.snapshot().activeState, "SKILLS_INSTALL");
    broker.receiveAgentEnvelope("researcher", env("researcher", "skills_installed", { installed: [{ name: "tdd" }], errors: [] }, "skills"));
    assert.equal(broker.snapshot().activeAgent, "skills", "waits for the advisor's installer");
    broker.receiveAgentEnvelope("advisor", env("advisor", "skills_installed", { installed: [], errors: [{ source: "o/r", error: "offline" }] }, "skills"));
    assert.equal(broker.snapshot().activeAgent, "root");
    assert.equal(broker.snapshot().activeState, "PLAN_DRAFT");
    const record = JSON.parse(fs.readFileSync(path.join(tmp, "skills.json"), "utf8"));
    assert.equal(record.installed.advisor.errors[0].error, "offline");
    const plan = (await broker.poll("advisor", 0, 50)).messages.find((m) => m.agentId === "root" && m.kind === "start");
    assert.match(plan.text, /Installed skills: tdd/);
    // A late ack after installation is refused quietly.
    const late = broker.receiveAgentEnvelope("advisor", env("advisor", "skills_installed", {}, "skills"));
    assert.equal(late.ok, false);
    assert.equal(late.wait, true);
  });
});
