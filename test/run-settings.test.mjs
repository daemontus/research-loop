import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { agentCodeHash, CODE_ROOT } from "../agent/lib/code-hash.mjs";
import { createBroker, readSessionLog } from "../control-plane/broker.mjs";
import { launchSettings, restoreSettings } from "../orchestrator/run.mjs";

function fakeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-hash-"));
  fs.mkdirSync(path.join(root, "agent", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent", "main.mjs"), "main();\n");
  fs.writeFileSync(path.join(root, "agent", "lib", "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return root;
}

describe("agent code fingerprint", () => {
  it("is stable, ignores non-source files, and changes with the agent code or dependencies", () => {
    const root = fakeCheckout();
    const h = agentCodeHash(root);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(agentCodeHash(root), h);
    fs.writeFileSync(path.join(root, "agent", ".DS_Store"), "junk");
    fs.writeFileSync(path.join(root, "agent", "NOTES.md"), "not code");
    assert.equal(agentCodeHash(root), h, "dotfiles and non-source files do not count");
    fs.writeFileSync(path.join(root, "agent", "lib", "a.mjs"), "export const a = 2;\n");
    const changed = agentCodeHash(root);
    assert.notEqual(changed, h);
    fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
    assert.notEqual(agentCodeHash(root), changed);
  });

  it("covers this checkout's agent code", () => {
    assert.match(agentCodeHash(CODE_ROOT), /^[0-9a-f]{16}$/);
  });
});

describe("agent registration handshake", () => {
  const newBroker = (opts) =>
    createBroker({ task: "x", runDir: fs.mkdtempSync(path.join(os.tmpdir(), "rl-reg-")), sessionId: "s", skipSkills: true, expectedCodeHash: "aaaa", ...opts });

  it("accepts agents running this checkout's code", () => {
    const broker = newBroker();
    broker.start();
    assert.equal(broker.register("researcher", "aaaa").ok, true);
    assert.equal(broker.snapshot().registered.researcher, true);
  });

  it("refuses a stale image (or one from before the check) and ends the run with the reason", () => {
    for (const hash of ["bbbb", null]) {
      const broker = newBroker({ image: "research-loop-agent:latest" });
      broker.start();
      const r = broker.register("advisor", hash);
      assert.equal(r.ok, false);
      assert.match(r.error, /the image research-loop-agent:latest is out of date/);
      assert.match(r.error, /docker build -f Dockerfile\.agent -t research-loop-agent:latest/);
      assert.equal(broker.snapshot().state, "ABORTED");
      assert.match(broker.snapshot().terminalReason, /^stale agent image: /);
    }
  });

  it("--allow-stale-image proceeds with a logged warning", () => {
    const broker = newBroker({ allowStaleImage: true });
    broker.start();
    assert.equal(broker.register("researcher", "bbbb").ok, true);
    assert.notEqual(broker.snapshot().state, "ABORTED");
  });
});

describe("launch settings in run.json", () => {
  const args = (extra = {}) => ({
    task: "t",
    taskFile: "task.txt",
    resume: null,
    image: "research-loop-agent:latest",
    local: false,
    cpu: null,
    thinking: "medium",
    maxPlanChanges: 0,
    explicit: new Set(),
    ...extra,
  });

  it("saves every setting except the per-invocation ones", () => {
    const saved = launchSettings(args({ image: "toolbox:v2", cpu: 4 }));
    assert.deepEqual(saved, { image: "toolbox:v2", local: false, cpu: 4, thinking: "medium", maxPlanChanges: 0 });
  });

  it("restores saved settings on resume unless they are given again", () => {
    const a = args({ thinking: "high", explicit: new Set(["thinking", "resume"]) });
    const restored = restoreSettings(a, { image: "toolbox:v2", cpu: 4, thinking: "low", maxPlanChanges: 2, unknownOld: 1 });
    assert.deepEqual(restored.sort(), ["cpu", "image", "maxPlanChanges"]);
    assert.equal(a.image, "toolbox:v2", "the image is no longer forgotten on resume");
    assert.equal(a.thinking, "high", "a flag given again wins");
    assert.ok(!("unknownOld" in a));
  });
});

describe("--view of an aborted run", () => {
  it("shows the abort although replay skips it (so --resume could continue)", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-view-"));
    const live = createBroker({ task: "x", runDir, sessionId: "s", skipSkills: true });
    live.start();
    live.abort("provider failure");
    const entries = readSessionLog(runDir);
    const resumable = createBroker({ task: "x", runDir, sessionId: "s", skipSkills: true, replayEntries: entries });
    assert.equal(resumable.snapshot().state, "PLAN_DRAFT");
    const viewed = createBroker({ task: "x", runDir, sessionId: "s", skipSkills: true, replayEntries: entries });
    viewed.freeze();
    assert.equal(viewed.snapshot().state, "ABORTED");
    assert.equal(viewed.snapshot().terminalReason, "provider failure");
  });
});
