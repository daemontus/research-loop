import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { genericToolsFor, makeTools } from "../agent/lib/tools.mjs";
import { makeGoalTools } from "../agent/lib/goal-tools.mjs";
import { createBrokerClient } from "../agent/lib/broker-client.mjs";
import { startControlPlane } from "../control-plane/server.mjs";

const goal = (id) => ({ id, title: `Goal ${id}`, description: `Do ${id}.`, acceptance: [`${id} works`] });

/** Drive a control plane to the point where orchestrator S2 has started leaf S3. */
async function withRun(fn, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-subagents-"));
  const transcriptDir = path.join(tmp, "transcripts");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const cp = await startControlPlane({ token: "t", task: "task", transcriptDir, runDir: tmp, sessionId: "s", port: 0, skipSkills: true, ...opts });
  const send = (role, kind, payload = {}, agentId = "root") => {
    const r = cp.broker.receiveAgentEnvelope(role, { role, kind, goalId: payload.goalId ?? null, text: "", payload, ts: Date.now(), agentId });
    assert.equal(r.ok, true, `${role} ${kind}: ${r.error}`);
  };
  try {
  send("advisor", "propose_plan", { goals: [goal("G1"), goal("G2")] });
  send("researcher", "accept_plan");
  send("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "Build G1.", justification: "small" });
  send("advisor", "approve_subagent", { conditions: ["stay in src/"] });
  send("researcher", "submit_result", { report: "G1 built.", notes: "Use make, not cmake." }, "S1");
  send("advisor", "accept_result", { feedback: "verified" }, "S1");
  send("researcher", "proceed", { assessment: "fine" });
  send("researcher", "propose_subagent", {
    goalId: "G2",
    mode: "split",
    instructions: "Two parts.",
    justification: "distinct phases",
    subgoals: [goal("G2.1"), goal("G2.2")],
  });
  send("advisor", "approve_subagent");
  send("researcher", "propose_subagent", { goalId: "G2.1", mode: "full", instructions: "Part one.", justification: "small" }, "S2");
  send("advisor", "approve_subagent", {}, "S2");
    return await fn({ cp, tmp, transcriptDir, send, base: `http://127.0.0.1:${cp.port}` });
  } finally {
    cp.close();
  }
}

describe("subagent sessions", () => {
  it("builds the session tree, briefs and run-folder records", async () => {
    await withRun(async ({ cp, tmp }) => {
      const snap = cp.broker.snapshot();
      assert.equal(snap.activeAgent, "S3");
      const byId = Object.fromEntries(snap.agents.map((a) => [a.id, a]));
      assert.equal(byId.S1.kind, "leaf");
      assert.equal(byId.S1.state, "DONE");
      assert.equal(byId.S2.kind, "orchestrator");
      assert.equal(byId.S2.state, "CHILD_RUNNING");
      assert.equal(byId.S3.parentId, "S2");
      assert.equal(byId.S3.depth, 2);
      assert.equal(byId.root.state, "CHILD_RUNNING");

      const s3 = cp.broker.sessionInfo("S3");
      assert.match(s3.brief, /G2 — Goal G2/, "the goal chain is in the brief");
      assert.match(s3.brief, /Part one\./);
      // G1's notes reach the next top-level goal's orchestrator, not G2.1 (a different level).
      assert.match(cp.broker.sessionInfo("S2").brief, /Use make, not cmake\./);

      assert.match(fs.readFileSync(path.join(tmp, "agents", "S1", "notes.md"), "utf8"), /Use make/);
      assert.match(fs.readFileSync(path.join(tmp, "agents", "S1", "brief.md"), "utf8"), /stay in src\//);
      assert.ok(fs.existsSync(path.join(tmp, "plans", "S2", "v1.md")));
      const goalsMd = fs.readFileSync(path.join(tmp, "goals.md"), "utf8");
      assert.match(goalsMd, /\[x\] G1 — Goal G1 \(subagent S1\)/);
      assert.match(goalsMd, /\[~\] G2 — Goal G2 \(subagent S2\)/);
      assert.match(goalsMd, /  \[~\] G2\.1 — Goal G2\.1 \(subagent S3\)/);
    });
  });

  it("refuses to split at the maximum depth", async () => {
    // With --max-subagent-depth 1 the main session's children must be leaves,
    // so delegating G2 with mode "split" (in the shared setup) is refused.
    await assert.rejects(
      withRun(() => assert.fail("unreachable"), { maxSubagentDepth: 1 }),
      /mode "split" is not available/,
    );
  });

  it("serves goals, goal details and sessions over HTTP, and the agents' goal tools use them", async () => {
    await withRun(async ({ base }) => {
      const tree = await (await fetch(`${base}/api/goals?token=t`)).json();
      assert.deepEqual(tree.goals.map((g) => [g.id, g.status, g.depth]), [
        ["G1", "done", 0],
        ["G2", "in_progress", 0],
        ["G2.1", "in_progress", 1],
        ["G2.2", "planned", 1],
      ]);
      const missing = await fetch(`${base}/api/goal?id=nope&token=t`);
      assert.equal(missing.status, 404);
      const agent = await (await fetch(`${base}/api/agent?agent=S2&token=t`)).json();
      assert.equal(agent.agent.kind, "orchestrator");
      assert.deepEqual(agent.agent.goals.map((g) => g.id), ["G2.1", "G2.2"]);

      const client = createBrokerClient({ brokerUrl: base, role: "researcher", token: "t" });
      const [listGoals, readGoal] = makeGoalTools(client);
      const listed = (await listGoals.execute("1", {})).content[0].text;
      assert.match(listed, /\[x\] G1 — Goal G1 \(subagent S1\)\n\[~\] G2/);
      const read = (await readGoal.execute("2", { id: "G1" })).content[0].text;
      assert.match(read, /Report:\nG1 built\./);
      assert.match(read, /Notes for later agents:\nUse make/);
      await assert.rejects(() => readGoal.execute("3", { id: "nope" }), /unknown goal id/);
    });
  });

  it("streams subagent transcripts exactly once", async () => {
    await withRun(async ({ base, transcriptDir }) => {
      fs.mkdirSync(path.join(transcriptDir, "agents", "S3"), { recursive: true });
      fs.writeFileSync(
        path.join(transcriptDir, "agents", "S3", "researcher.jsonl"),
        JSON.stringify({ ts: 1, agent: "researcher", agentId: "S3", kind: "system", content: "SUB-ENTRY" }) + "\n",
      );
      const ac = new AbortController();
      const res = await fetch(`${base}/api/stream?token=t`, { signal: ac.signal });
      const reader = res.body.getReader();
      let text = "";
      const timer = setTimeout(() => ac.abort(), 3000);
      try {
        while (!text.includes("SUB-ENTRY") || !text.includes("session_started")) {
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
      assert.ok(text.includes('"kind":"session_started"'), "control-log events are streamed too");
    });
  });
});

describe("tools by session kind", () => {
  const tools = makeTools(fs.mkdtempSync(path.join(os.tmpdir(), "rl-kinds-")), { supportsImage: true });
  const names = (role, kind) => genericToolsFor(role, kind, tools).map((t) => t.name).sort();

  it("coordinating researchers only read", () => {
    assert.deepEqual(names("researcher", "main"), ["grep", "list_dir", "read_file", "read_image"]);
    assert.deepEqual(names("researcher", "orchestrator"), ["grep", "list_dir", "read_file", "read_image"]);
  });

  it("leaf researchers and advisors get the full toolset; the skills researcher gets a shell", () => {
    assert.ok(names("researcher", "leaf").includes("bash"));
    assert.ok(names("researcher", "leaf").includes("edit_file"));
    assert.ok(names("advisor", "main").includes("bash"));
    assert.deepEqual(names("researcher", "skills"), ["bash", "grep", "list_dir", "read_file", "read_image"]);
  });
});
