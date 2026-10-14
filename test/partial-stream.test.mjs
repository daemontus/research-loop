import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import { createBrokerClient } from "../agent/lib/broker-client.mjs";
import { bindControlTools, researcherControlToolDefs } from "../agent/lib/control-tools.mjs";
import { makeCredentialStore } from "../agent/lib/model-providers.mjs";
import { createPartialStreamer } from "../agent/lib/partial-stream.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";
import { startControlPlane } from "../control-plane/server.mjs";

describe("partial streamer", () => {
  it("batches deltas in order and coalesces same-channel text", async () => {
    const sent = [];
    const s = createPartialStreamer(async (ops) => sent.push(ops), { intervalMs: 20 });
    s.start();
    s.delta("thinking", "hm");
    s.delta("thinking", "m…");
    s.delta("text", "Hel");
    s.delta("text", "lo");
    s.tool("bash");
    await s.end();
    assert.deepEqual(sent.flat(), [
      { op: "start", id: 1 },
      { op: "delta", id: 1, channel: "thinking", text: "hmm…" },
      { op: "delta", id: 1, channel: "text", text: "Hello" },
      { op: "tool", id: 1, name: "bash" },
      { op: "end", id: 1 },
    ]);
  });

  it("keeps going when a send fails", async () => {
    const sent = [];
    let fail = true;
    const s = createPartialStreamer(
      async (ops) => {
        if (fail) {
          fail = false;
          throw new Error("down");
        }
        sent.push(...ops);
      },
      { intervalMs: 5 },
    );
    s.delta("text", "lost");
    await s.flush();
    s.delta("text", "kept");
    await s.end();
    assert.deepEqual(
      sent.map((o) => o.op + (o.text || "")),
      ["deltakept", "end"],
    );
  });

  it("streams a real agent turn (thinking, text, tool call)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-partial-"));
    const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
    const models = builtinModels({ credentials: makeCredentialStore({}) });
    models.setProvider(faux.provider);
    const controlState = { pendingHandoff: null };
    const controller = {
      setHandoff: (h) => {
        controlState.pendingHandoff = h;
        return true;
      },
    };
    const ops = [];
    const session = new AgentSession({
      role: "researcher",
      model: models.getModel("faux", "m1"),
      models,
      systemPrompt: "You are the researcher.",
      tools: bindControlTools(researcherControlToolDefs(), controller),
      sandbox: tmp,
      transcript: createTranscriptWriter(path.join(tmp, "researcher.jsonl"), "researcher"),
      controlState,
      partialStreamer: createPartialStreamer(async (batch) => ops.push(...batch), { intervalMs: 5 }),
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Let me think about this."),
          fauxText("Here is my plan."),
          fauxToolCall("submit_plan", {
            goalId: "G1",
            title: "Goal",
            plan: ["a"],
            acceptanceCriteria: ["b"],
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await session.start();
    await session.runPrompt("go");
    await session.partialStreamer.flush();

    const text = (channel) =>
      ops.filter((o) => o.op === "delta" && o.channel === channel).map((o) => o.text).join("");
    assert.equal(ops[0].op, "start");
    assert.equal(text("thinking"), "Let me think about this.");
    assert.equal(text("text"), "Here is my plan.");
    assert.ok(ops.some((o) => o.op === "tool" && o.name === "submit_plan"));
    assert.equal(ops.filter((o) => o.op === "end").length, ops.filter((o) => o.op === "start").length);
  });
});

describe("control-plane partial relay", () => {
  it("relays partial ops to SSE clients without persisting them", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-partial-cp-"));
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
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${cp.port}/api/stream?token=t`, { signal: ac.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const got = (async () => {
        while (!text.includes('"type":"partial"')) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      })();

      const client = createBrokerClient({
        brokerUrl: `http://127.0.0.1:${cp.port}`,
        role: "advisor",
        token: "t",
      });
      await new Promise((r) => setTimeout(r, 50));
      const ok = await client.partial([{ op: "delta", id: 1, channel: "text", text: "LIVE-TOKEN" }]);
      assert.equal(ok?.ok, true);
      await got;
      ac.abort();

      const line = text.split("\n").find((l) => l.includes('"type":"partial"'));
      const msg = JSON.parse(line.slice("data: ".length));
      assert.equal(msg.agent, "advisor");
      assert.equal(msg.ops[0].text, "LIVE-TOKEN");

      const onDisk = fs
        .readdirSync(transcriptDir)
        .map((f) => fs.readFileSync(path.join(transcriptDir, f), "utf8"))
        .join("");
      assert.ok(!onDisk.includes("LIVE-TOKEN"), "partials must not be persisted");

      const bad = await createBrokerClient({
        brokerUrl: `http://127.0.0.1:${cp.port}`,
        role: "advisor",
        token: "wrong",
      }).partial([{ op: "start", id: 1 }]);
      assert.equal(bad, null, "unauthenticated partials are rejected");
    } finally {
      cp.close();
    }
  });
});
