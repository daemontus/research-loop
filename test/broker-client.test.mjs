import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBrokerClient } from "../agent/lib/broker-client.mjs";
import { startControlPlane } from "../control-plane/server.mjs";

async function withControlPlane(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-client-"));
  const transcriptDir = path.join(tmp, "transcripts");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const cp = await startControlPlane({
    token: "t",
    task: "x",
    transcriptDir,
    sessionId: "s",
    goalsPath: path.join(tmp, "GOALS.md"),
    port: 0,
  });
  try {
    return await fn(cp);
  } finally {
    cp.close();
  }
}

describe("broker client illegal handoffs", () => {
  it("returns a structured rejection and queues a state-aware correction prompt", async () => {
    await withControlPlane(async (cp) => {
      const client = createBrokerClient({
        brokerUrl: `http://127.0.0.1:${cp.port}`,
        role: "researcher",
        token: "t",
      });
      await client.register();

      // The researcher is in the skills phase (expects propose_skills); a result is illegal.
      const res = await client.send({
        role: "researcher",
        kind: "result",
        goalId: "G3",
        text: "sneaky result",
        payload: {},
      });
      assert.equal(res.ok, false, "must not throw; must return structured rejection");
      assert.match(res.error, /cannot send 'result'/);

      // The broker should have queued a correction prompt telling us what to do.
      const batch = await client.poll(0, 500);
      const correction = batch.messages.find((m) => m.kind === "prompt");
      assert.ok(correction, "a correction prompt should be queued");
      assert.match(correction.text, /propose_skills/);
      assert.match(correction.text, /RESEARCHER_SKILLS/);
    });
  });
});
