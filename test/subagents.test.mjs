import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker, replaySessionLog } from "../control-plane/broker.mjs";
import { startControlPlane } from "../control-plane/server.mjs";
import {
  applyEnvelope,
  applyStart,
  applySubagentDone,
  createSessionState,
  STATES,
} from "../control-plane/state-machine.mjs";
import { buildAdvisorPrompt, buildResearcherPrompt } from "../agent/lib/prompts.mjs";

const env = (role, kind, extra = {}) => ({
  role,
  kind,
  goalId: extra.goalId ?? null,
  text: extra.text ?? "",
  payload: extra.payload ?? {},
  agentId: extra.agentId,
  ts: Date.now(),
});

function executing() {
  let s = applyStart(createSessionState(), { skipSkills: true }).state;
  s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
  return applyEnvelope(s, env("advisor", "plan_approved", { goalId: "G1" })).state;
}

describe("state machine: subagents", () => {
  it("routes a proposal to the advisor and returns to the original phase on rejection", () => {
    const s = executing();
    let r = applyEnvelope(s, env("researcher", "subagent_proposal"));
    assert.equal(r.state.state, STATES.ADVISOR_REVIEW_SUBAGENT);
    assert.equal(r.deliveries[0].to, "advisor");
    r = applyEnvelope(r.state, env("advisor", "subagent_changes"));
    assert.equal(r.state.state, STATES.RESEARCHER_EXECUTE);
    assert.equal(r.deliveries[0].to, "researcher");
  });

  it("pauses the parent on approval and resumes it when the subagent is done", () => {
    let s = applyStart(createSessionState(), { skipSkills: true }).state;
    s = applyEnvelope(s, env("researcher", "subagent_proposal")).state;
    const r = applyEnvelope(s, env("advisor", "subagent_approved"));
    assert.equal(r.state.state, STATES.SUBAGENT_RUNNING);
    assert.equal(r.spawn, true);
    assert.equal(r.deliveries.length, 0);
    assert.ok(applyEnvelope(r.state, env("researcher", "proposal")).error, "paused session rejects handoffs");
    const done = applySubagentDone(r.state, env("control", "prompt", { text: "report" }));
    assert.equal(done.state.state, STATES.RESEARCHER_DECOMPOSE);
    assert.equal(done.deliveries[0].to, "researcher");
  });

  it("ends a subagent on accepted completion without human sign-off", () => {
    let s = applyStart(createSessionState({ subagent: true })).state;
    assert.equal(s.state, STATES.RESEARCHER_DECOMPOSE, "subagents skip the skills phase");
    s = applyEnvelope(s, env("researcher", "proposal", { goalId: "G1" })).state;
    // The shortcut from plan review is not allowed for subagents.
    assert.ok(applyEnvelope(s, env("advisor", "task_accepted")).error);
    s = applyEnvelope(s, env("advisor", "plan_changes", { goalId: "G1" })).state;
    s = applyEnvelope(s, env("researcher", "task_request")).state;
    const r = applyEnvelope(s, env("advisor", "task_accepted"));
    assert.equal(r.state.state, STATES.DONE);
    assert.equal(r.terminal, "subagent_done");
  });
});

function setup(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-subagents-"));
  const sandbox = path.join(tmp, "researcher-sandbox");
  const transcriptDir = path.join(tmp, "transcripts");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "GOALS.md"), "# root goals\n");
  const broker = createBroker({
    token: "t",
    task: "Main task",
    transcriptDir,
    sessionId: "s",
    skipSkills: true,
    researcherSandbox: sandbox,
    agentsDir: path.join(tmp, "agents"),
    ...opts,
  });
  broker.start();
  const cursors = { researcher: 0, advisor: 0 };
  const next = async (role) => {
    const batch = await broker.poll(role, cursors[role], 200);
    cursors[role] = batch.cursor;
    return batch.messages;
  };
  const send = (role, kind, extra = {}) => broker.receiveAgentEnvelope(role, env(role, kind, extra));
  return { tmp, sandbox, transcriptDir, broker, next, send };
}

async function spawnS1(t) {
  await t.next("researcher"); // start
  t.send("researcher", "subagent_proposal", {
    payload: { title: "Survey", instructions: "Survey prior work.", goalId: "G1", rationale: "focus" },
  });
  const [proposal] = await t.next("advisor");
  assert.equal(proposal.kind, "subagent_proposal");
  assert.equal(proposal.agentId, "root");
  const ok = t.send("advisor", "subagent_approved", { payload: { feedback: "go", conditions: ["be brief"] } });
  assert.equal(ok.ok, true);
}

describe("broker: subagent lifecycle", () => {
  it("spawns, protects GOALS.md, and reports back to the parent", async () => {
    const t = setup();
    await spawnS1(t);

    const snap = t.broker.snapshot();
    assert.equal(snap.activeAgent, "S1");
    assert.equal(snap.state, STATES.SUBAGENT_RUNNING);
    assert.deepEqual(
      snap.agents.map((a) => [a.id, a.parentId]),
      [["root", null], ["S1", "root"]],
    );

    const [start] = await t.next("researcher");
    assert.equal(start.kind, "start");
    assert.equal(start.agentId, "S1");
    assert.equal(start.agent.title, "Survey");
    assert.match(start.text, /Survey prior work/);
    assert.match(start.text, /be brief/);
    assert.ok(fs.existsSync(path.join(t.tmp, "agents", "S1", "instructions.md")));

    // A handoff for the paused parent is refused.
    assert.equal(t.send("researcher", "proposal", { goalId: "G2" }).ok, false);

    // S1 tampers with the root goals and forgets its report: refused + restored.
    const s1 = { agentId: "S1" };
    fs.mkdirSync(path.join(t.sandbox, "agents", "S1"), { recursive: true });
    fs.writeFileSync(path.join(t.sandbox, "GOALS.md"), "# hijacked\n");
    const refused = t.send("researcher", "task_request", s1);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /REPORT\.md is missing/);
    assert.match(refused.error, /protected goal files/);
    assert.equal(fs.readFileSync(path.join(t.sandbox, "GOALS.md"), "utf8"), "# root goals\n");
    const [correction] = await t.next("researcher");
    assert.equal(correction.agentId, "S1");
    assert.match(correction.text, /rejected by the orchestrator/);

    // A human note for the paused root researcher waits for the report.
    const held = t.broker.humanMessage("researcher", "check S1 carefully", {}, "root");
    assert.equal(held.deferred, true);

    fs.writeFileSync(path.join(t.sandbox, "agents", "S1", "REPORT.md"), "# Report\nDid the survey.\n");
    assert.equal(t.send("researcher", "task_request", s1).ok, true);
    assert.equal((await t.next("advisor"))[0].agentId, "S1");
    assert.equal(t.send("advisor", "task_accepted", s1).ok, true);

    const after = t.broker.snapshot();
    assert.equal(after.activeAgent, "root");
    assert.equal(after.state, STATES.RESEARCHER_DECOMPOSE, "back in the phase it proposed from");
    assert.equal(after.agents.find((a) => a.id === "S1").state, STATES.DONE);

    const msgs = await t.next("researcher");
    assert.ok(msgs.some((m) => m.kind === "agent_done" && m.agentId === "S1"));
    const report = msgs.find((m) => m.kind === "prompt" && m.agentId === "root");
    assert.match(report.text, /subagent S1 finished/);
    assert.match(report.text, /Did the survey/);
    assert.match(report.text, /check S1 carefully/);
    assert.equal(
      fs.readFileSync(path.join(t.tmp, "agents", "S1", "REPORT.md"), "utf8"),
      "# Report\nDid the survey.\n",
    );

    // The parent advisor sees the report with its next handoff.
    t.send("researcher", "proposal", { goalId: "G2" });
    const advisorMsgs = await t.next("advisor");
    const proposal = advisorMsgs.find((m) => m.kind === "proposal");
    assert.match(proposal.text, /\[subagent report\] Subagent S1/);
  });

  it("refuses proposals beyond the depth limit", async () => {
    const t = setup({ maxSubagentDepth: 0 });
    await t.next("researcher");
    const r = t.send("researcher", "subagent_proposal", { payload: { title: "x", instructions: "y" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /disabled/);
  });

  it("supports nested subagents and protects sibling/ancestor goal files", async () => {
    const t = setup();
    await spawnS1(t);
    await t.next("researcher");
    const s1 = { agentId: "S1" };
    fs.mkdirSync(path.join(t.sandbox, "agents", "S1"), { recursive: true });
    fs.writeFileSync(path.join(t.sandbox, "agents", "S1", "GOALS.md"), "# S1 goals\n");
    t.send("researcher", "subagent_proposal", { ...s1, payload: { title: "Deep", instructions: "go deeper" } });
    await t.next("advisor");
    t.send("advisor", "subagent_approved", { ...s1, payload: { feedback: "ok" } });
    const snap = t.broker.snapshot();
    assert.equal(snap.activeAgent, "S2");
    const s2 = snap.agents.find((a) => a.id === "S2");
    assert.equal(s2.parentId, "S1");
    assert.equal(s2.depth, 2);
    const protectedFiles = JSON.parse(
      fs.readFileSync(path.join(t.tmp, "agents", "S2", "goals-snapshot.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(protectedFiles).sort(), ["GOALS.md", "agents/S1/GOALS.md"]);
  });
});

describe("subagent replay and resume", () => {
  it("rebuilds the agent tree mid-subagent and resumes the active subagent", async () => {
    const t = setup();
    await spawnS1(t);
    t.send("researcher", "proposal", { agentId: "S1", goalId: "G1" });

    const replayed = replaySessionLog(t.transcriptDir);
    assert.equal(replayed.activeId, "S1");
    assert.equal(replayed.state.state, STATES.SUBAGENT_RUNNING);
    const s1 = replayed.agents.find((a) => a.id === "S1");
    assert.equal(s1.state.state, STATES.ADVISOR_REVIEW_PLAN);
    assert.equal(s1.instructions, "Survey prior work.");
    assert.deepEqual(Object.keys(s1.snapshot), ["GOALS.md"]);

    const broker = createBroker({
      token: "t",
      task: "Main task",
      transcriptDir: t.transcriptDir,
      sessionId: "s",
      researcherSandbox: t.sandbox,
      agentsDir: path.join(t.tmp, "agents"),
      initialState: replayed.state,
      initialAgents: replayed.agents,
      initialActiveId: replayed.activeId,
    });
    const res = broker.resume("RESUME TEXT");
    assert.equal(res.agentId, "S1");
    assert.equal(res.expecting, "advisor");
    const batch = await broker.poll("advisor", 0, 100);
    assert.equal(batch.messages[0].agentId, "S1");
    assert.equal(batch.messages[0].text, "RESUME TEXT");
    assert.equal(batch.messages[0].agent.title, "Survey");

    // The subagent continues; the next delivery to its (fresh) researcher
    // carries a re-orientation note.
    broker.receiveAgentEnvelope("advisor", env("advisor", "plan_approved", { agentId: "S1", goalId: "G1" }));
    const r = await broker.poll("researcher", 0, 100);
    assert.match(r.messages[0].text, /RESUMED in a fresh container/);
  });
});

describe("prompts: subagents", () => {
  const base = { sandbox: "/sandbox", configDir: null, task: "Main task" };
  const subagent = { id: "S3", parentId: "S1", depth: 2, title: "Deep", instructions: "Do the deep thing." };

  it("tells subagent researchers their operating constraints", () => {
    const p = buildResearcherPrompt({ ...base, subagent });
    assert.match(p, /You are subagent S3/);
    assert.match(p, /Do the deep thing\./);
    assert.match(p, /\/sandbox\/agents\/S3\/GOALS\.md/);
    assert.match(p, /NEVER modify \/sandbox\/GOALS\.md/);
    assert.match(p, /\/sandbox\/agents\/S3\/REPORT\.md/);
    assert.match(p, /no human sign-off/);
    assert.doesNotMatch(p, /Phase 0 — skills discovery/);
    assert.match(p, /propose_subagent/);
  });

  it("omits delegation when the depth limit is reached", () => {
    const p = buildResearcherPrompt({ ...base, subagent, canSpawnSubagents: false });
    assert.doesNotMatch(p, /propose_subagent/);
  });

  it("explains subagent review to advisors", () => {
    assert.match(buildAdvisorPrompt(base), /approve_subagent/);
    const p = buildAdvisorPrompt({ ...base, subagent });
    assert.match(p, /advisor of subagent S3/);
    assert.match(p, /\/researcher-sandbox\/agents\/S3\/GOALS\.md/);
    assert.match(p, /REPORT\.md/);
    assert.doesNotMatch(p, /approve_skills/);
  });
});

describe("control plane: subagent views", () => {
  it("serves per-agent goals and streams subagent transcripts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-subagent-ui-"));
    const sandbox = path.join(tmp, "researcher-sandbox");
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(path.join(sandbox, "agents", "S1"), { recursive: true });
    fs.mkdirSync(path.join(transcriptDir, "agents", "S1"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "GOALS.md"), "ROOT-GOALS");
    fs.writeFileSync(path.join(sandbox, "agents", "S1", "GOALS.md"), "S1-GOALS");
    fs.writeFileSync(
      path.join(transcriptDir, "agents", "S1", "researcher.jsonl"),
      JSON.stringify({ ts: 1, agent: "researcher", agentId: "S1", kind: "system", content: "SUB-ENTRY" }) + "\n",
    );
    const cp = await startControlPlane({
      token: "t",
      task: "task",
      transcriptDir,
      sessionId: "s",
      goalsPath: path.join(sandbox, "GOALS.md"),
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${cp.port}`;
      const root = await (await fetch(`${base}/api/goals?token=t`)).json();
      const sub = await (await fetch(`${base}/api/goals?agent=S1&token=t`)).json();
      const bad = await (await fetch(`${base}/api/goals?agent=..%2F..&token=t`)).json();
      assert.equal(root.goals, "ROOT-GOALS");
      assert.equal(sub.goals, "S1-GOALS");
      assert.equal(bad.goals, "");

      const ac = new AbortController();
      const res = await fetch(`${base}/api/stream?token=t`, { signal: ac.signal });
      const reader = res.body.getReader();
      let text = "";
      const timer = setTimeout(() => ac.abort(), 3000);
      try {
        while (!text.includes("SUB-ENTRY")) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // timed out
      } finally {
        clearTimeout(timer);
        ac.abort();
      }
      assert.equal(text.split("SUB-ENTRY").length - 1, 1, "subagent entry delivered exactly once");
    } finally {
      cp.close();
    }
  });
});

describe("delegation steering", () => {
  const base = { sandbox: "/sandbox", configDir: null, task: "Main task", skipSkills: true };

  it("frames the main researcher as supervisor only in encouraged mode", () => {
    const optional = buildResearcherPrompt(base);
    const encouraged = buildResearcherPrompt({ ...base, delegation: "encouraged" });
    assert.match(optional, /Delegating goals to subagents/);
    assert.match(optional, /Decide for EVERY goal/);
    assert.doesNotMatch(optional, /SUPERVISOR/);
    assert.match(encouraged, /You are the SUPERVISOR of this task/);
    const sub = buildResearcherPrompt({
      ...base,
      delegation: "encouraged",
      subagent: { id: "S1", parentId: "root", depth: 1, title: "x", instructions: "y" },
    });
    assert.doesNotMatch(sub, /SUPERVISOR/, "subagents are not supervisors");
    const none = buildResearcherPrompt({ ...base, canSpawnSubagents: false });
    assert.doesNotMatch(none, /`execution`/);
  });

  it("asks the advisor to check the execution choice", () => {
    assert.match(buildAdvisorPrompt(base), /Check the plan's `execution` choice/);
    assert.match(buildAdvisorPrompt({ ...base, delegation: "encouraged" }), /SUPERVISOR mode/);
    assert.doesNotMatch(buildAdvisorPrompt({ ...base, subagentsEnabled: false }), /`execution`/);
  });

  it("offers the execution fields only when the researcher can delegate", async () => {
    const { researcherControlToolDefs } = await import("../agent/lib/control-tools.mjs");
    const plan = (o) => researcherControlToolDefs(o).find((d) => d.name === "submit_plan");
    assert.ok(plan().parameters.properties.execution);
    assert.equal(plan({ canSpawnSubagents: false }).parameters.properties.execution, undefined);
  });

  it("reminds the researcher to delegate at decision points", async () => {
    const t = setup({ delegation: "encouraged" });
    await t.next("researcher");
    t.send("researcher", "proposal", { goalId: "G1", payload: { execution: "subagent" } });
    t.send("advisor", "plan_approved", { goalId: "G1" });
    let [msg] = await t.next("researcher");
    assert.match(msg.text, /execution: "subagent"\. Delegate it now with propose_subagent \(goalId G1\)/);

    t.send("researcher", "result", { goalId: "G1" });
    t.send("advisor", "result_accepted", { goalId: "G1" });
    [msg] = await t.next("researcher");
    assert.match(msg.text, /you are the supervisor/);

    // A self-executed plan gets no delegation nudge on approval.
    t.send("researcher", "proposal", { goalId: "G2", payload: { execution: "self" } });
    t.send("advisor", "plan_approved", { goalId: "G2" });
    [msg] = await t.next("researcher");
    assert.doesNotMatch(msg.text, /\[orchestrator\]/);
  });

  it("does not nudge when subagents are disabled", async () => {
    const t = setup({ maxSubagentDepth: 0 });
    await t.next("researcher");
    t.send("researcher", "proposal", { goalId: "G1", payload: { execution: "subagent" } });
    t.send("advisor", "plan_approved", { goalId: "G1" });
    t.send("researcher", "result", { goalId: "G1" });
    t.send("advisor", "result_accepted", { goalId: "G1" });
    const msgs = await t.next("researcher");
    assert.ok(msgs.every((m) => !/\[orchestrator\]/.test(m.text)));
  });
});
