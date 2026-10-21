import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEngine } from "../control-plane/engine.mjs";
import { renderTransitionTable } from "../control-plane/state-machine.mjs";

const goal = (id, extra = {}) => ({
  id,
  title: `Goal ${id}`,
  description: `Do ${id} properly.`,
  acceptance: [`${id} works`],
  skills: [],
  ...extra,
});

/** Drive an engine while recording every input, so the run can be replayed. */
function driver(opts = {}) {
  const engine = createEngine({ task: "Build the thing", ...opts });
  const log = [];
  let ts = 1000;
  const deliveries = [];
  const keep = (r) => {
    for (const e of r.effects) if (e.type === "deliver") deliveries.push(e);
    return r;
  };
  return {
    engine,
    log,
    deliveries,
    start() {
      log.push({ kind: "start", ts: ++ts });
      return keep(engine.start(ts));
    },
    act(role, kind, payload = {}, sid = engine.activeId()) {
      const r = keep(engine.handoff(role, sid, { kind, text: `${role} says ${kind}`, payload }, ++ts));
      if (r.ok) log.push({ kind: "handoff", from: role, agentId: sid, handoffKind: kind, text: `${role} says ${kind}`, payload, ts });
      return r;
    },
    installed(role) {
      log.push({ kind: "skills_installed", from: role, payload: { installed: [{ name: "tdd" }] }, ts: ++ts });
      return keep(engine.skillsInstalled(role, { installed: [{ name: "tdd" }] }, ts));
    },
    human(action, text = "") {
      log.push({ kind: "human_decision", action, text, ts: ++ts });
      return keep(engine.humanDecision({ action, text }, ts));
    },
    lastTo(role) {
      return [...deliveries].reverse().find((d) => d.role === role)?.envelope;
    },
  };
}

const ok = (r) => {
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.ok, true);
  return r;
};

test("a full run: skills, plan, leaf, orchestrator with an aborted subgoal, human sign-off, replay", () => {
  const d = driver();
  ok(d.start());
  assert.equal(d.engine.activeId(), "skills");
  assert.equal(d.lastTo("researcher").kind, "start");

  ok(d.act("researcher", "propose_skills", { summary: "tdd helps", skills: [{ name: "tdd", source: "o/skills", why: "tests" }] }));
  ok(d.act("advisor", "approve_skills", { feedback: "fine" }));
  assert.equal(d.lastTo("researcher").kind, "install_skills");
  assert.equal(d.lastTo("advisor").kind, "install_skills");
  ok(d.installed("researcher"));
  assert.equal(d.engine.activeId(), "skills", "waits for both installers");
  ok(d.installed("advisor"));
  assert.equal(d.engine.activeId(), "root");
  assert.match(d.lastTo("advisor").text, /Installed skills: tdd/);

  // The advisor plans; the researcher reviews.
  assert.equal(d.act("researcher", "accept_plan").wait, true, "not the researcher's turn");
  assert.match(d.act("advisor", "propose_plan", { goals: [goal("G1"), goal("G1")] }).error, /duplicate id/);
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1"), goal("G2")], rationale: "two steps" }));
  assert.equal(d.lastTo("researcher").kind, "propose_plan");
  ok(d.act("researcher", "request_plan_changes", { requiredChanges: ["clearer G2"] }));
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1"), goal("G2", { skills: ["tdd"] })] }));
  ok(d.act("researcher", "accept_plan", { feedback: "clear" }));
  const prep = d.lastTo("researcher");
  assert.deepEqual(prep.contextOps, [{ op: "prune_tool_calls", keep: ["propose_plan", "accept_plan"] }]);
  assert.match(prep.text, /next goal, G1/);

  // G1: delegated in full to a leaf.
  assert.match(d.act("researcher", "propose_subagent", { goalId: "G2", mode: "full", instructions: "x", justification: "y" }).error, /next goal is G1/);
  assert.match(d.act("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "x" }).error, /justification/);
  ok(d.act("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "Use the repo.", justification: "One unit." }));
  assert.match(d.lastTo("advisor").text, /accepted your plan/, "deferred note rides on the advisor's next handoff");
  assert.deepEqual(d.lastTo("advisor").contextOps, [{ op: "prune_tool_calls", keep: ["propose_plan", "accept_plan"] }]);
  ok(d.act("advisor", "approve_subagent", { feedback: "go", conditions: ["keep it small"] }));
  assert.equal(d.engine.activeId(), "S1");
  const s1Start = d.lastTo("researcher");
  assert.equal(s1Start.agent.kind, "leaf");
  assert.match(s1Start.agent.brief, /keep it small/);
  ok(d.act("researcher", "submit_result", { summary: "done", report: "Built G1.", notes: "Use make." }));
  ok(d.act("advisor", "request_result_changes", { requiredChanges: ["add docs"] }));
  ok(d.act("researcher", "submit_result", { summary: "done", report: "Built G1 with docs.", notes: "Use make." }));
  ok(d.act("advisor", "accept_result", { feedback: "verified", verification: ["ran make"] }));
  assert.equal(d.engine.activeId(), "root");
  const reflect = d.lastTo("researcher");
  assert.match(reflect.text, /subagent S1 finished/);
  assert.match(reflect.text, /Built G1 with docs/);
  assert.match(reflect.text, /proceed: continue with the next goal, G2/);
  assert.equal(d.lastTo("researcher").kind, "prompt");

  // G2: split into two subgoals, handled by an orchestrator.
  assert.match(d.act("researcher", "finish_session", { summary: "x" }).error, /still planned \(G2\)/);
  ok(d.act("researcher", "proceed", { assessment: "on track" }));
  assert.match(
    d.act("researcher", "propose_subagent", { goalId: "G2", mode: "split", instructions: "i", justification: "j", subgoals: [goal("X.1"), goal("X.2")] }).error,
    /must start with 'G2\.'/,
  );
  ok(
    d.act("researcher", "propose_subagent", {
      goalId: "G2",
      mode: "split",
      instructions: "Two phases.",
      justification: "Distinct phases.",
      subgoals: [goal("G2.1"), goal("G2.2")],
    }),
  );
  assert.match(d.lastTo("advisor").text, /S1 finished/, "the parent advisor hears about the finished child");
  ok(d.act("advisor", "approve_subagent", { feedback: "ok" }));
  assert.equal(d.engine.activeId(), "S2");
  assert.match(d.lastTo("researcher").agent.brief, /Earlier goals at this level[\s\S]*G1[\s\S]*Use make/);
  assert.match(d.lastTo("researcher").text, /next goal, G2\.1/);

  ok(d.act("researcher", "propose_subagent", { goalId: "G2.1", mode: "full", instructions: "a", justification: "b" }));
  ok(d.act("advisor", "approve_subagent", {}));
  assert.equal(d.engine.activeId(), "S3");
  ok(d.act("researcher", "submit_result", { report: "G2.1 done", notes: "n1" }));
  ok(d.act("advisor", "accept_result", { feedback: "ok" }));
  assert.equal(d.engine.activeId(), "S2");
  assert.match(d.act("researcher", "propose_plan_change", { goals: [], rationale: "x" }).error, /not a researcher action in a orchestrator/);
  ok(d.act("researcher", "proceed", {}));
  ok(d.act("researcher", "propose_subagent", { goalId: "G2.2", mode: "full", instructions: "a", justification: "b" }));
  ok(d.act("advisor", "approve_subagent", {}));
  assert.equal(d.engine.activeId(), "S4");
  assert.match(d.lastTo("researcher").agent.brief, /G2\.1[\s\S]*n1/, "sibling notes reach the next subgoal");
  ok(d.act("researcher", "request_abort", { reason: "impossible", report: "tried", proposal: "drop it" }));
  ok(d.act("advisor", "confirm_abort", { feedback: "agreed" }));
  assert.equal(d.engine.activeId(), "S2");
  ok(d.act("researcher", "finish_session", { report: "G2.1 done, G2.2 aborted", notes: "n2" }));
  ok(d.act("advisor", "accept_completion", { feedback: "good enough" }));
  assert.equal(d.engine.activeId(), "root");

  ok(d.act("researcher", "finish_session", { summary: "All done.", notes: "final notes" }));
  const snap = d.engine.snapshot();
  assert.equal(snap.state, "AWAITING_HUMAN");
  assert.equal(snap.humanRequest.type, "finish");
  ok(d.human("approve"));
  assert.equal(d.engine.snapshot().state, "DONE");

  const statuses = Object.fromEntries(d.engine.goalTree().map((g) => [g.id, g.status]));
  assert.deepEqual(statuses, { G1: "done", G2: "done", "G2.1": "done", "G2.2": "aborted" });
  assert.match(d.engine.renderGoalTree(), /\[x\] G2 — Goal G2 \(subagent S2\)\n  \[x\] G2\.1/);
  assert.match(d.engine.goalDetail("G2.2"), /aborted: impossible[\s\S]*Proposal: drop it/);

  // Replaying the log rebuilds the same run.
  const replayed = createEngine({ task: "Build the thing" });
  const again = replayed.replay(d.log);
  assert.deepEqual(again.agents, d.engine.snapshot().agents);
  assert.deepEqual(replayed.goalTree(), d.engine.goalTree());
  assert.equal(again.state, "DONE");
});

test("plan changes in the main session replace only planned goals", () => {
  const d = driver({ skipSkills: true });
  ok(d.start());
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1"), goal("G2"), goal("G3")] }));
  ok(d.act("researcher", "accept_plan"));
  ok(d.act("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "i", justification: "j" }));
  ok(d.act("advisor", "approve_subagent"));
  ok(d.act("researcher", "submit_result", { report: "r" }));
  ok(d.act("advisor", "accept_result"));
  assert.match(d.act("researcher", "propose_plan_change", { goals: [goal("G1")], rationale: "r" }).error, /already used by an existing goal \(done\)/);
  ok(d.act("researcher", "propose_plan_change", { goals: [goal("G2"), goal("G4")], rationale: "G3 is obsolete" }));
  ok(d.act("advisor", "reject_plan_change", { feedback: "keep G3" }));
  assert.equal(d.engine.snapshot().activeState, "REFLECT");
  ok(d.act("researcher", "propose_plan_change", { goals: [], rationale: "nothing left to do" }));
  ok(d.act("advisor", "approve_plan_change", { feedback: "ok" }));
  assert.equal(d.engine.snapshot().activeState, "REFLECT", "no goals left: back to reflection");
  assert.deepEqual(d.engine.goalTree().map((g) => g.id), ["G1"]);
  assert.match(d.lastTo("researcher").next, /finish_session/);
  ok(d.act("researcher", "abort_session", { reason: "changed my mind" }));
  ok(d.human("reject", "keep going"));
  assert.equal(d.lastTo("researcher").kind, "human_decision");
  ok(d.act("researcher", "abort_session", { reason: "really" }));
  ok(d.human("approve"));
  assert.equal(d.engine.snapshot().state, "ABORTED");
});

test("depth and rejection limits", () => {
  const d = driver({ skipSkills: true, maxSubagentDepth: 1, maxSubagentRejections: 2 });
  ok(d.start());
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1")] }));
  ok(d.act("researcher", "accept_plan"));
  assert.match(d.lastTo("researcher").text, /splitting into subgoals is not available/);
  assert.match(
    d.act("researcher", "propose_subagent", { goalId: "G1", mode: "split", instructions: "i", justification: "j", subgoals: [goal("G1.1"), goal("G1.2")] }).error,
    /not available/,
  );
  ok(d.act("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "i", justification: "j" }));
  ok(d.act("advisor", "reject_subagent", { requiredChanges: ["more detail"] }));
  ok(d.act("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "i2", justification: "j" }));
  ok(d.act("advisor", "reject_subagent", { requiredChanges: ["still vague"] }));
  const snap = d.engine.snapshot();
  assert.equal(snap.state, "AWAITING_HUMAN");
  assert.equal(snap.humanRequest.type, "abort");
});

test("human notes wait for their agent's turn; corrections repeat the instructions", () => {
  const d = driver({ skipSkills: true });
  ok(d.start());
  const note = d.engine.humanMessage("researcher", "prefer small goals");
  assert.equal(note.deferred, true);
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1")] }));
  assert.match(d.lastTo("researcher").text, /\[human note\] prefer small goals/);
  const corr = d.engine.correction("researcher", "root", "bad call").effects[0].envelope;
  assert.match(corr.text, /state PLAN_REVIEW; call one of: .*`accept_plan`/);
  assert.match(corr.text, /`request_plan_changes`/);
});

test("resume marks lost contexts and re-prompts the acting agent", () => {
  const d = driver({ skipSkills: true });
  ok(d.start());
  ok(d.act("advisor", "propose_plan", { goals: [goal("G1")] }));
  const replayed = createEngine({ task: "Build the thing", skipSkills: true });
  replayed.replay(d.log);
  const r = replayed.resume("be careful");
  const prompt = r.effects.find((e) => e.type === "deliver").envelope;
  assert.equal(prompt.kind, "start");
  assert.match(prompt.text, /RESUMED[\s\S]*PLAN_REVIEW[\s\S]*be careful/);
  const next = replayed.handoff("researcher", "root", { kind: "accept_plan", payload: {} });
  ok(next);
  // The advisor's next delivery says its conversation was lost.
  replayed.handoff("researcher", "root", { kind: "propose_subagent", payload: { goalId: "G1", mode: "full", instructions: "i", justification: "j" } });
  const adv = replayed.snapshot();
  assert.equal(adv.activeState, "SUBAGENT_REVIEW");
});

test("docs/PROTOCOL.md embeds the current transition table", () => {
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "PROTOCOL.md"), "utf8");
  const m = doc.match(/<!-- BEGIN GENERATED TRANSITIONS -->\n([\s\S]*?)\n<!-- END GENERATED TRANSITIONS -->/);
  assert.ok(m, "markers present");
  assert.equal(m[1], renderTransitionTable(), "regenerate with: node scripts/protocol-doc.mjs");
});
