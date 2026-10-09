import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyEnvelope,
  applyHumanDecision,
  applyStart,
  createSessionState,
  markAborted,
  STATES,
} from "../control-plane/state-machine.mjs";

const env = (role, kind, extra = {}) => ({
  role,
  kind,
  goalId: extra.goalId ?? null,
  text: extra.text ?? "",
  payload: extra.payload ?? {},
  ts: Date.now(),
});

function started() {
  return applyStart(createSessionState()).state;
}

function startedPlanning() {
  return applyStart(createSessionState(), { skipSkills: true }).state;
}

describe("state machine: skills phase", () => {
  it("runs skills proposal -> approve -> install -> ready -> planning", () => {
    let s = started();
    assert.equal(s.state, STATES.RESEARCHER_SKILLS);

    let r = applyEnvelope(s, env("researcher", "skills_proposal"));
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_SKILLS);
    assert.equal(r.deliveries[0].to, "advisor");
    s = r.state;

    r = applyEnvelope(s, env("advisor", "skills_approved"));
    assert.equal(r.state.state, STATES.RESEARCHER_INSTALL_SKILLS);
    assert.equal(r.deliveries[0].to, "researcher");
    s = r.state;

    r = applyEnvelope(s, env("researcher", "skills_ready"));
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(r.deliveries[0].to, "researcher");
    assert.equal(r.deliveries[0].envelope.role, "control");
  });

  it("allows request_skill_changes to loop back to discovery", () => {
    let s = started();
    s = applyEnvelope(s, env("researcher", "skills_proposal")).state;
    const r = applyEnvelope(s, env("advisor", "skills_changes"));
    assert.equal(r.state.state, STATES.RESEARCHER_SKILLS);
    assert.equal(r.deliveries[0].to, "researcher");
  });

  it("rejects planning before skills are settled", () => {
    const s = started();
    const r = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" }));
    assert.ok(r.error);
    assert.equal(r.state.state, STATES.RESEARCHER_SKILLS);
  });
});

describe("state machine: happy path", () => {
  it("runs proposal -> approve -> result -> accept -> ... -> human approve", () => {
    let s = startedPlanning();

    let r = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" }));
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_PLAN);
    assert.equal(r.deliveries.length, 1);
    assert.equal(r.deliveries[0].to, "advisor");
    assert.equal(r.state.currentGoalId, "G1");
    s = r.state;

    r = applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G1" }));
    assert.equal(r.state.state, STATES.RESEARCHER_EXECUTE);
    assert.equal(r.deliveries[0].to, "researcher");
    s = r.state;

    r = applyEnvelope(s, env("researcher", "result", { goalId: "G1" }));
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_RESULT);
    s = r.state;

    r = applyEnvelope(s, env("advisor", "result_accepted", { goalId: "G1" }));
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(r.notice, "goal met");
    s = r.state;

    r = applyEnvelope(s, env("researcher", "task_request"));
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_TASK);
    s = r.state;

    r = applyEnvelope(s, env("advisor", "task_accepted"));
    assert.equal(r.state.state, STATES.AWAITING_HUMAN);
    s = r.state;

    r = applyHumanDecision(s, { action: "approve", text: "looks good" });
    assert.equal(r.state.state, STATES.DONE);
    assert.equal(r.terminal, "done");
  });
});

describe("state machine: plan revision", () => {
  it("allows submit_plan (proposal) while executing", () => {
    let s = startedPlanning();
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G2" })).state;
    s = applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G2" })).state;
    assert.equal(s.state, STATES.RESEARCHER_EXECUTE);

    const r = applyEnvelope(
      s,
      env("researcher", "proposal", {
        goalId: "G2",
        payload: { revisionOf: "G2", rationale: "infeasible; new approach" },
      }),
    );
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_PLAN);
    assert.equal(r.notice, "plan revised");
    assert.equal(r.deliveries[0].to, "advisor");
  });

  it("allows plan_changes to send the researcher back to planning", () => {
    let s = startedPlanning();
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
    const r = applyEnvelope(s, env("advisor", "plan_changes", { goalId: "G1" }));
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(r.deliveries[0].to, "researcher");
  });
});

describe("state machine: illegal transitions", () => {
  it("rejects an advisor message while the researcher is decomposing", () => {
    const s = startedPlanning();
    const r = applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G1" }));
    assert.ok(r.error);
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
  });

  it("rejects researcher result while in plan review", () => {
    let s = startedPlanning();
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
    const r = applyEnvelope(s, env("researcher", "result", { goalId: "G1" }));
    assert.ok(r.error);
  });

  it("does not accept agent messages while awaiting human", () => {
    let s = startedPlanning();
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
    s = applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G1" })).state;
    s = applyEnvelope(s, env("researcher", "task_request")).state;
    s = applyEnvelope(s, env("advisor", "task_accepted")).state;
    const r = applyEnvelope(s, env("researcher", "proposal", { goalId: "G2" }));
    assert.ok(r.error);
  });
});

describe("state machine: human decisions", () => {
  function awaitingHuman() {
    let s = startedPlanning();
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
    s = applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G1" })).state;
    s = applyEnvelope(s, env("researcher", "task_request")).state;
    return applyEnvelope(s, env("advisor", "task_accepted")).state;
  }

  it("reject sends a human message back to the researcher", () => {
    const r = applyHumanDecision(awaitingHuman(), { action: "reject", text: "not enough" });
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(r.deliveries[0].to, "researcher");
    assert.equal(r.deliveries[0].envelope.role, "human");
    assert.equal(r.deliveries[0].envelope.kind, "human_message");
  });

  it("extend grants budget and resumes", () => {
    const r = applyHumanDecision(awaitingHuman(), { action: "extend" });
    assert.equal(r.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(r.deliveries[0].to, "researcher");
  });

  it("rejects a human decision outside AWAITING_HUMAN", () => {
    const r = applyHumanDecision(started(), { action: "approve" });
    assert.ok(r.error);
  });
});

describe("state machine: abort", () => {
  it("marks the session aborted", () => {
    const r = markAborted(started(), "budget");
    assert.equal(r.state.state, STATES.ABORTED);
    assert.equal(r.terminal, "aborted");
    assert.equal(r.state.terminalReason, "budget");
  });
});
