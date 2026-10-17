import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSkillFrontmatter } from "../agent/lib/skills.mjs";
import { makeTools, resolveInSandbox } from "../agent/lib/tools.mjs";
import { createBroker } from "../control-plane/broker.mjs";
import { createSessionState, STATES } from "../control-plane/state-machine.mjs";

function newBroker(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-regress-"));
  return createBroker({
    token: "t",
    task: "x",
    transcriptDir: path.join(tmp, "transcripts"),
    sessionId: "s",
    skipSkills: true,
    ...opts,
  });
}

const envelope = (role, kind, extra = {}) => ({
  role,
  kind,
  goalId: "G1",
  text: "t",
  payload: {},
  ts: Date.now(),
  ...extra,
});

describe("broker regressions", () => {
  it("caps consecutive invalid handoffs only (an accepted one resets the count)", () => {
    const broker = newBroker({ maxRejections: 2 });
    broker.start(); // RESEARCHER_DECOMPOSE
    assert.equal(broker.receiveAgentEnvelope("researcher", envelope("researcher", "result")).ok, false);
    assert.equal(broker.receiveAgentEnvelope("researcher", envelope("researcher", "proposal")).ok, true);
    // Invalid in-turn handoff (advisor expected): one rejection after progress must not abort.
    assert.equal(broker.receiveAgentEnvelope("advisor", envelope("advisor", "result_accepted")).ok, false);
    assert.notEqual(broker.snapshot().state, STATES.ABORTED);
    // A second consecutive one hits the cap.
    broker.receiveAgentEnvelope("advisor", envelope("advisor", "result_accepted"));
    assert.equal(broker.snapshot().state, STATES.ABORTED);
  });

  it("refuses out-of-turn handoffs quietly (no correction prompt, not counted)", async () => {
    const broker = newBroker({ maxRejections: 2 });
    broker.start();
    broker.receiveAgentEnvelope("researcher", envelope("researcher", "proposal"));
    const before = (await broker.poll("researcher", 0, 50)).cursor;
    for (let i = 0; i < 5; i += 1) {
      const r = broker.receiveAgentEnvelope("researcher", envelope("researcher", "result"));
      assert.equal(r.ok, false);
      assert.equal(r.wait, true);
      assert.match(r.error, /not your turn/);
    }
    assert.notEqual(broker.snapshot().state, STATES.ABORTED);
    const after = await broker.poll("researcher", before, 50);
    assert.equal(after.messages.length, 0, "no correction prompt for the researcher");
  });

  it("never downgrades a DONE session to ABORTED", () => {
    const broker = newBroker({ initialState: { ...createSessionState(), state: STATES.DONE } });
    broker.abort("agent exited during shutdown");
    assert.equal(broker.snapshot().state, STATES.DONE);
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
