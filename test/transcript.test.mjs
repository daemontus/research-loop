import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createTranscriptWriter } from "../agent/lib/transcript.mjs";

describe("transcript writer", () => {
  it("never lets payload fields clobber reserved keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-transcript-"));
    const file = path.join(dir, "researcher.jsonl");
    const w = createTranscriptWriter(file, "researcher");
    const entry = w.write("handoff", {
      kind: "proposal", // must NOT overwrite the entry kind
      agent: "hacker", // must NOT overwrite the agent
      handoffKind: "proposal",
      direction: "out",
      text: "hello",
    });
    w.close();

    assert.equal(entry.kind, "handoff");
    assert.equal(entry.agent, "researcher");
    assert.equal(entry.handoffKind, "proposal");
    assert.equal(entry.direction, "out");

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.kind, "handoff");
    assert.equal(parsed.handoffKind, "proposal");
  });

  it("serializes messages with reasoning and tool calls", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-transcript-"));
    const w = createTranscriptWriter(path.join(dir, "advisor.jsonl"), "advisor");
    w.writeMessage({
      role: "assistant",
      timestamp: 1,
      content: [
        { type: "thinking", thinking: "why" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c1", name: "approve_plan", arguments: { goalId: "G1" } },
      ],
      stopReason: "toolUse",
    });
    w.close();
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "advisor.jsonl"), "utf8").trim());
    assert.equal(parsed.reasoning, "why");
    assert.equal(parsed.content, "answer");
    assert.equal(parsed.tool_calls[0].name, "approve_plan");
  });
});
