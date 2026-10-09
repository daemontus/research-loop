import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBroker } from "../control-plane/broker.mjs";

describe("broker session log", () => {
  it("keeps control-plane event kinds and stores envelope kind separately", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-broker-log-"));
    const transcriptDir = path.join(tmp, "transcripts");
    const broker = createBroker({
      token: "t",
      task: "x",
      transcriptDir,
      sessionId: "s",
      skipSkills: true,
    });
    broker.register("researcher");
    broker.start();

    const res = broker.receiveAgentEnvelope("researcher", {
      role: "researcher",
      kind: "proposal",
      goalId: "G1",
      text: "plan",
      payload: { plan: ["a"] },
      ts: Date.now(),
    });
    assert.equal(res.ok, true);

    const entries = fs
      .readFileSync(path.join(transcriptDir, "session.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const handoff = entries.find((e) => e.kind === "handoff");
    assert.ok(handoff, "a handoff event should be logged");
    assert.equal(handoff.handoffKind, "proposal");
    assert.equal(handoff.agent, "control");

    const deliver = entries.find((e) => e.kind === "deliver" && e.to === "advisor");
    assert.ok(deliver, "a deliver event should be logged");
    assert.equal(deliver.deliverKind, "proposal");
    assert.equal(deliver.to, "advisor");

    // No entry's kind should have been clobbered by the envelope kind.
    assert.equal(entries.filter((e) => e.kind === "result").length, 0);
  });
});
