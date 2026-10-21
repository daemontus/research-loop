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

      // The skills session expects propose_skills from the researcher; a result is illegal.
      const res = await client.send({
        role: "researcher",
        kind: "submit_result",
        goalId: null,
        text: "sneaky result",
        payload: {},
        agentId: "skills",
      });
      assert.equal(res.ok, false, "must not throw; must return structured rejection");
      assert.match(res.error, /'submit_result' is not a researcher action in a skills session/);

      // The broker should have queued a correction prompt telling us what to do.
      const batch = await client.poll(0, 500);
      const correction = batch.messages.find((m) => m.kind === "prompt");
      assert.ok(correction, "a correction prompt should be queued");
      assert.match(correction.text, /`propose_skills`/);
      assert.match(correction.text, /SKILLS_PROPOSE/);
    });
  });
});
