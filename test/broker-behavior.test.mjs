import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker } from "../control-plane/broker.mjs";

function newBroker(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-beh-"));
  return createBroker({
    token: "t",
    task: "x",
    transcriptDir: path.join(tmp, "transcripts"),
    sessionId: "s",
    skipSkills: true,
    ...opts,
  });
}

describe("broker human-message routing", () => {
  it("defers a note for the non-expected role and merges it into the next handoff", async () => {
    const broker = newBroker();
    broker.register("researcher");
    broker.start(); // state RESEARCHER_DECOMPOSE expects researcher

    // Advisor is not expected yet -> deferred.
    const deferred = broker.humanMessage("advisor", "advisor please double-check X");
    assert.equal(deferred.ok, true);
    assert.equal(deferred.deferred, true);

    // Researcher is expected -> delivered immediately.
    const immediate = broker.humanMessage("researcher", "researcher please include Y");
    assert.equal(immediate.ok, true);
    assert.equal(immediate.deferred, undefined);

    // Researcher proposes -> advisor becomes expected; deferred note merges in.
    broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "proposal",
      goalId: "G1",
      text: "the plan",
      payload: {},
      ts: Date.now(),
    });

    const batch = await broker.poll("advisor", 0, 500);
    const proposal = batch.messages.find((m) => m.kind === "proposal");
    assert.ok(proposal, "advisor should receive the proposal");
    assert.match(proposal.text, /human note/);
    assert.match(proposal.text, /double-check X/);
    assert.match(proposal.text, /the plan/);
  });

  it("rejects a human message when no role is expected", () => {
    const broker = newBroker();
    // Force terminal state via rejections cap: just use maxHandoffs cap.
    broker.start();
    broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "proposal",
      goalId: "G1",
      text: "",
      payload: {},
    });
    broker.receiveAgentEnvelope("advisor", {
      role: "advisor",
      kind: "plan_approved",
      goalId: "G1",
      text: "",
      payload: {},
    });
    broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "task_request",
      text: "",
      payload: {},
    });
    broker.receiveAgentEnvelope("advisor", {
      role: "advisor",
      kind: "task_accepted",
      text: "",
      payload: {},
    });
    assert.equal(broker.snapshot().state, "AWAITING_HUMAN");
    const res = broker.humanMessage("researcher", "hi");
    assert.equal(res.ok, false);
    assert.match(res.error, /no agent is expected/);
  });
});

describe("broker researcher-step cap", () => {
  it("counts researcher goal steps, not all handoffs", () => {
    const broker = newBroker({ maxHandoffs: 1 });
    broker.start();
    broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "proposal",
      goalId: "G1",
      text: "",
      payload: {},
    });
    assert.equal(broker.snapshot().researcherSteps, 1);
    assert.equal(broker.snapshot().state, "ABORTED");
  });
});

describe("broker skills phase", () => {
  it("validates confirm_skills_installed against the skills directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-skills-"));
    const skillsDir = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skillsDir, "tdd"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "tdd", "SKILL.md"), "# tdd\n");
    const broker = newBroker({
      skipSkills: false,
      transcriptDir: path.join(tmp, "transcripts"),
      installedSkillsPath: skillsDir,
    });
    broker.start();
    assert.equal(broker.snapshot().state, "RESEARCHER_SKILLS");

    assert.equal(
      broker.receiveAgentEnvelope("researcher", {
        role: "researcher",
        kind: "skills_proposal",
        goalId: null,
        text: "",
        payload: { skills: [{ name: "tdd" }] },
      }).ok,
      true,
    );
    assert.equal(
      broker.receiveAgentEnvelope("advisor", {
        role: "advisor",
        kind: "skills_approved",
        goalId: null,
        text: "",
        payload: {},
      }).ok,
      true,
    );
    assert.equal(broker.snapshot().state, "RESEARCHER_INSTALL_SKILLS");

    // Claims a skill that is not on disk -> rejected.
    const bad = broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "skills_ready",
      goalId: null,
      text: "",
      payload: { installed: [{ name: "does-not-exist" }] },
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not found under \/sandbox\/skills/);
    assert.equal(broker.snapshot().state, "RESEARCHER_INSTALL_SKILLS");

    // Real one passes and moves to planning.
    const good = broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "skills_ready",
      goalId: null,
      text: "",
      payload: { installed: [{ name: "tdd" }] },
    });
    assert.equal(good.ok, true);
    assert.equal(broker.snapshot().state, "RESEARCHER_DECOMPOSE");
  });
});
