import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildRunStats, renderStatsSummary } from "../orchestrator/stats.mjs";

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function setup() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-stats-"));
  const transcriptDir = path.join(runDir, "transcripts");
  const researcherSandbox = path.join(runDir, "researcher-sandbox");

  writeJsonl(path.join(transcriptDir, "researcher.jsonl"), [
    { kind: "message", role: "user", content: "go", ts: 900 },
    {
      kind: "message",
      role: "assistant",
      ts: 1000,
      stopReason: "toolUse",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 50 },
      tool_calls: [
        { id: "c1", name: "bash", arguments: {} },
        { id: "c2", name: "read_file", arguments: {} },
      ],
    },
    { kind: "message", role: "toolResult", toolName: "bash", ts: 1100 },
    { kind: "system", content: "provider-error-retry:1 at turn 2", ts: 1200 },
    { kind: "handoff", direction: "out", handoffKind: "proposal", goalId: "G1", ts: 1300 },
    {
      kind: "message",
      role: "assistant",
      ts: 1400,
      stopReason: "error",
      errorMessage: "terminated",
      usage: { input: 10, output: 5 },
    },
  ]);
  writeJsonl(path.join(transcriptDir, "advisor.jsonl"), [
    {
      kind: "message",
      role: "assistant",
      ts: 1500,
      stopReason: "toolUse",
      usage: { input: 200, output: 40, cacheRead: 10 },
      tool_calls: [{ id: "a1", name: "approve_plan", arguments: {} }],
    },
    { kind: "handoff", direction: "in", handoffKind: "proposal", goalId: "G1", ts: 1600 },
  ]);

  fs.mkdirSync(path.join(researcherSandbox, "skills", "foo"), { recursive: true });
  fs.writeFileSync(path.join(researcherSandbox, "skills", "foo", "SKILL.md"), "# foo\n");
  fs.mkdirSync(path.join(researcherSandbox, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(researcherSandbox, ".agents", "ignored"), "x");
  fs.writeFileSync(path.join(researcherSandbox, "GOALS.md"), "# goals\n");
  fs.writeFileSync(path.join(researcherSandbox, "notes.md"), "notes\n");

  const snapshot = {
    state: "ABORTED",
    terminalReason: "provider failure",
    startedAt: 1000,
    finishedAt: 2000,
    handoffs: 3,
    researcherSteps: 1,
    currentGoalId: "G2",
    humanDecisions: [{ action: "approve", ts: 1900 }],
  };

  const opts = {
    sessionId: "s1",
    task: "do a thing",
    runDir,
    models: { researcher: "p:r", advisor: "p:a" },
    snapshot,
    agentStats: {},
    agentErrors: { researcher: "provider failure during researcher phase" },
    transcriptDir,
    researcherSandbox,
    orchestratorStartedAt: 500,
    orchestratorFinishedAt: 2500,
  };
  return { stats: buildRunStats(opts), runDir, opts };
}

describe("buildRunStats", () => {
  it("aggregates tokens by category and role", () => {
    const { stats } = setup();
    assert.deepEqual(stats.tokens.total, {
      input: 310,
      output: 65,
      cacheRead: 15,
      cacheWrite: 1,
      reasoning: 50,
      totalTokens: 441,
    });
    assert.equal(stats.tokens.byRole.researcher.input, 110);
    assert.equal(stats.tokens.byRole.advisor.cacheRead, 10);
  });

  it("counts turns, tool calls, messages and errors", () => {
    const { stats } = setup();
    assert.equal(stats.turns.researcher, 2);
    assert.equal(stats.turns.advisor, 1);
    assert.equal(stats.turns.total, 3);
    assert.equal(stats.toolCalls.researcher.total, 2);
    assert.equal(stats.toolCalls.researcher.byTool.bash, 1);
    assert.equal(stats.toolCalls.advisor.byTool.approve_plan, 1);
    assert.equal(stats.messages.researcher.toolResult, 1);
  });

  it("derives recovery counters from system notes", () => {
    const { stats } = setup();
    assert.equal(stats.recovery.researcher.providerError, 1);
    assert.equal(stats.recovery.researcher.errorTurns, 1);
    assert.equal(stats.recovery.advisor.providerError, 0);
  });

  it("computes durations", () => {
    const { stats } = setup();
    assert.equal(stats.duration.totalMs, 2000);
    assert.equal(stats.duration.sessionMs, 1000);
    assert.equal(stats.duration.byRoleMs.researcher, 500);
    assert.equal(stats.duration.byRoleMs.advisor, 100);
  });

  it("collects goals, handoffs, skills and artifacts", () => {
    const { stats } = setup();
    assert.equal(stats.goals.count, 1);
    assert.deepEqual(stats.goals.ids, ["G1"]);
    assert.equal(stats.goals.byStatus, null, "no goal tree passed: ids come from handoffs");
    assert.equal(stats.handoffs.total, 3);
    assert.equal(stats.handoffs.byKind.proposal, 1);
    assert.deepEqual(stats.skills, { count: 1, names: ["foo"] });
    assert.equal(stats.artifacts.count, 2);
    assert.deepEqual(
      stats.artifacts.files.map((f) => f.path),
      ["GOALS.md", "notes.md"],
    );
    assert.equal(stats.humanDecisions.count, 1);
    assert.equal(stats.errors.researcher, "provider failure during researcher phase");
  });

  it("takes goal statuses from the harness's goal tree when given", () => {
    const { opts } = setup();
    const stats = buildRunStats({
      ...opts,
      goalTree: [
        { id: "G1", status: "done" },
        { id: "G1.1", status: "done" },
        { id: "G2", status: "aborted" },
      ],
    });
    assert.equal(stats.goals.count, 3);
    assert.deepEqual(stats.goals.byStatus, { done: 2, aborted: 1 });
  });

  it("renders a readable console summary", () => {
    const { stats } = setup();
    const text = renderStatsSummary(stats);
    assert.match(text, /ABORTED/);
    assert.match(text, /total 441/);
    assert.match(text, /researcher 2/);
  });
});
