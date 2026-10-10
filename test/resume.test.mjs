import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker, expectedRoleForState, replaySessionLog } from "../control-plane/broker.mjs";

function makeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-replay-"));
  fs.writeFileSync(path.join(dir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

describe("expectedRoleForState", () => {
  it("maps researcher/advisor/human states", () => {
    assert.equal(expectedRoleForState("RESEARCHER_EXECUTE"), "researcher");
    assert.equal(expectedRoleForState("ADVISOR_REVIEW_PLAN"), "advisor");
    assert.equal(expectedRoleForState("AWAITING_HUMAN"), null);
    assert.equal(expectedRoleForState("DONE"), null);
  });
});

describe("session log replay", () => {
  it("reconstructs the state machine from a session log", () => {
    const dir = makeLog([
      { kind: "start", task: "t", skipSkills: true, ts: 1000 },
      { kind: "handoff", from: "researcher", handoffKind: "proposal", goalId: "G1", text: "plan", payload: {}, ts: 2000 },
      { kind: "handoff", from: "advisor", handoffKind: "plan_approved", goalId: "G1", text: "ok", payload: {}, ts: 3000 },
      { kind: "handoff", from: "researcher", handoffKind: "result", goalId: "G1", text: "done", payload: {}, ts: 4000 },
      // the interruption itself must not change the replayed state
      { kind: "abort", reason: "boom", ts: 5000 },
    ]);
    const replayed = replaySessionLog(dir);
    assert.equal(replayed.started, true);
    assert.equal(replayed.skipSkills, true);
    assert.equal(replayed.state.state, "ADVISOR_REVIEW_RESULT");
    assert.equal(replayed.state.currentGoalId, "G1");
    assert.equal(replayed.researcherSteps, 2);
    assert.equal(replayed.state.startedAt, 1000);
    assert.equal(expectedRoleForState(replayed.state.state), "advisor");
  });

  it("preserves human decisions and skips rejected handoffs", () => {
    const dir = makeLog([
      { kind: "start", task: "t", skipSkills: true, ts: 1 },
      { kind: "handoff", from: "researcher", handoffKind: "result", goalId: "G1", text: "sneaky", payload: {}, ts: 2 },
      { kind: "handoff", from: "researcher", handoffKind: "proposal", goalId: "G2", text: "plan", payload: {}, ts: 3 },
      { kind: "handoff", from: "advisor", handoffKind: "task_accepted", goalId: null, text: "done", payload: {}, ts: 4 },
      { kind: "human_decision", action: "reject", text: "keep working", ts: 5 },
    ]);
    const replayed = replaySessionLog(dir);
    assert.equal(replayed.state.state, "RESEARCHER_DECOMPOSE");
    assert.equal(replayed.state.humanDecisions.length, 1);
    assert.equal(replayed.state.humanDecisions[0].action, "reject");
    assert.equal(replayed.state.humanDecisions[0].ts, 5);
    assert.equal(replayed.researcherSteps, 1); // the illegal result is not counted
  });
});

describe("resume", () => {
  it("delivers the resume prompt to the expected role and skips start()", async () => {
    const dir = makeLog([
      { kind: "start", task: "t", skipSkills: true, ts: 1000 },
      { kind: "handoff", from: "researcher", handoffKind: "proposal", goalId: "G1", text: "plan", payload: {}, ts: 2000 },
      { kind: "handoff", from: "advisor", handoffKind: "plan_changes", goalId: "G1", text: "nope", payload: { requiredChanges: ["x"] }, ts: 3000 },
    ]);
    const replayed = replaySessionLog(dir);
    const broker = createBroker({
      token: "t",
      task: "t",
      transcriptDir: dir,
      sessionId: "resume-1",
      initialState: replayed.state,
      initialResearcherSteps: replayed.researcherSteps,
    });
    // The broker was created with state already set; start() must not be called.
    const snap = broker.snapshot();
    assert.equal(snap.state, "RESEARCHER_DECOMPOSE");
    assert.equal(snap.researcherSteps, 1);

    const res = broker.resume("RESUME CONTEXT");
    assert.equal(res.ok, true);
    assert.equal(res.expecting, "researcher");

    const inbox = await broker.poll("researcher", 0, 200);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].role, "control");
    assert.equal(inbox.messages[0].kind, "start");
    assert.match(inbox.messages[0].text, /RESUME CONTEXT/);
  });

  it("resume in AWAITING_HUMAN delivers nothing to agents", async () => {
    const dir = makeLog([
      { kind: "start", task: "t", skipSkills: true, ts: 1 },
      { kind: "handoff", from: "researcher", handoffKind: "proposal", goalId: "G1", text: "plan", payload: {}, ts: 2 },
      { kind: "handoff", from: "advisor", handoffKind: "task_accepted", goalId: null, text: "done", payload: {}, ts: 3 },
    ]);
    const replayed = replaySessionLog(dir);
    assert.equal(replayed.state.state, "AWAITING_HUMAN");
    const broker = createBroker({
      token: "t",
      task: "t",
      transcriptDir: dir,
      sessionId: "resume-2",
      initialState: replayed.state,
    });
    const res = broker.resume("RESUME");
    assert.equal(res.expecting, null);
    const rInbox = await broker.poll("researcher", 0, 50);
    const aInbox = await broker.poll("advisor", 0, 50);
    assert.equal(rInbox.messages.length, 0);
    assert.equal(aInbox.messages.length, 0);
  });
});