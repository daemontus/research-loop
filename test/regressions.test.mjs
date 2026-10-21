import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSkillFrontmatter } from "../agent/lib/skills.mjs";
import { makeTools, resolveInSandbox } from "../agent/lib/tools.mjs";
import { createBroker } from "../control-plane/broker.mjs";

function newBroker(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-regress-"));
  return createBroker({ task: "x", runDir: tmp, sessionId: "s", skipSkills: true, ...opts });
}

const envelope = (role, kind, payload = {}, agentId = "root") => ({ role, kind, goalId: payload.goalId ?? null, text: "t", payload, ts: Date.now(), agentId });
const GOAL = { id: "G1", title: "t", description: "d", acceptance: ["a"] };

describe("broker regressions", () => {
  it("caps consecutive invalid handoffs only (an accepted one resets the count)", () => {
    const broker = newBroker({ maxRejections: 2 });
    broker.start(); // the advisor plans
    assert.equal(broker.receiveAgentEnvelope("advisor", envelope("advisor", "approve_subagent")).ok, false);
    assert.equal(broker.receiveAgentEnvelope("advisor", envelope("advisor", "propose_plan", { goals: [GOAL] })).ok, true);
    // Invalid in-turn handoff: one rejection after progress must not abort.
    assert.equal(broker.receiveAgentEnvelope("researcher", envelope("researcher", "proceed")).ok, false);
    assert.notEqual(broker.snapshot().state, "ABORTED");
    // A second consecutive one hits the cap.
    broker.receiveAgentEnvelope("researcher", envelope("researcher", "proceed"));
    assert.equal(broker.snapshot().state, "ABORTED");
  });

  it("refuses out-of-turn handoffs quietly (no correction prompt, not counted)", async () => {
    const broker = newBroker({ maxRejections: 2 });
    broker.start();
    const before = (await broker.poll("researcher", 0, 50)).cursor;
    for (let i = 0; i < 5; i += 1) {
      const r = broker.receiveAgentEnvelope("researcher", envelope("researcher", "accept_plan"));
      assert.equal(r.ok, false);
      assert.equal(r.wait, true);
      assert.match(r.error, /not your turn/);
    }
    assert.notEqual(broker.snapshot().state, "ABORTED");
    const after = await broker.poll("researcher", before, 50);
    assert.equal(after.messages.length, 0, "no correction prompt for the researcher");
  });

  it("never downgrades a DONE run to ABORTED", () => {
    const broker = newBroker();
    broker.start();
    const send = (role, kind, payload, agentId) => assert.equal(broker.receiveAgentEnvelope(role, envelope(role, kind, payload, agentId)).ok, true);
    send("advisor", "propose_plan", { goals: [GOAL] });
    send("researcher", "accept_plan", {});
    send("researcher", "propose_subagent", { goalId: "G1", mode: "full", instructions: "i", justification: "j" });
    send("advisor", "approve_subagent", {});
    send("researcher", "submit_result", { report: "r" }, "S1");
    send("advisor", "accept_result", {}, "S1");
    send("researcher", "finish_session", { summary: "done" });
    broker.humanDecision({ action: "approve" });
    assert.equal(broker.snapshot().state, "DONE");
    broker.abort("agent exited during shutdown");
    assert.equal(broker.snapshot().state, "DONE");
    assert.equal(broker.isClosed(), true);
  });
});

describe("agent tool regressions", () => {
  it("maps the in-container /sandbox prefix for writes", () => {
    assert.equal(resolveInSandbox("/tmp/sb", "/sandbox/a/b"), "/tmp/sb/a/b");
    assert.equal(resolveInSandbox("/tmp/sb", "/sandbox"), "/tmp/sb");
    assert.throws(() => resolveInSandbox("/tmp/sb", "/sandbox/../etc"), /escapes sandbox/);
    assert.throws(() => resolveInSandbox("/tmp/sb", "/etc/passwd"), /escapes sandbox/);
  });

  it("edit_file inserts replacement text literally ($ patterns included)", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rl-edit-"));
    fs.writeFileSync(path.join(sandbox, "f.sh"), "echo PID\n");
    const edit = makeTools(sandbox).find((t) => t.name === "edit_file");
    await edit.execute("1", { path: "f.sh", oldString: "PID", newString: "$$ $& $'" });
    assert.equal(fs.readFileSync(path.join(sandbox, "f.sh"), "utf8"), "echo $$ $& $'\n");
  });

  it("parses folded multi-line skill descriptions", () => {
    const md = "---\nname: a\ndescription: >-\n  line one\n  line two\nlicense: MIT\n---\nbody";
    assert.deepEqual(parseSkillFrontmatter(md), { name: "a", description: "line one line two" });
  });
});
