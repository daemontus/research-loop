import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  COMPACTION_MARKER_PREFIX,
  TOOL_OUTPUT_OMITTED,
  buildCompactionUserMessage,
  buildSandboxSnapshot,
  compactMessages,
  isCompactionMarker,
  isCompactionTrigger,
  lastAssistantReasoning,
  lastAssistantStopReason,
  lastAssistantErrorDetail,
  isProviderErrorStop,
  formatProviderErrorSummary,
  combineRunErrors,
  previousSessionStartIndex,
  stripAssistantReasoning,
  stripToolResultContent,
} from "../agent/lib/context-compaction.mjs";

describe("isCompactionTrigger", () => {
  it("matches length only", () => {
    assert.equal(isCompactionTrigger("length"), true);
    assert.equal(isCompactionTrigger("LENGTH"), true);
    assert.equal(isCompactionTrigger("aborted"), false);
    assert.equal(isCompactionTrigger("toolUse"), false);
    assert.equal(isCompactionTrigger(null), false);
  });
});

describe("compactMessages", () => {
  const toolResult = (id, text) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text }],
    timestamp: 1,
  });
  const assistant = (thinking, stopReason = "toolUse") => ({
    role: "assistant",
    content: [
      ...(thinking ? [{ type: "thinking", thinking }] : []),
      { type: "text", text: "ok" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ],
    stopReason,
    timestamp: 1,
  });
  const user = (text) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  });

  it("strips all tool outputs and keeps reasoning when no prior compaction", () => {
    const messages = [
      user("bootstrap"),
      assistant("reason-0"),
      toolResult("t1", "HUGE OUTPUT"),
    ];
    const out = compactMessages(messages);
    assert.equal(out[0].content[0].text, "bootstrap");
    assert.equal(out[1].content.find((c) => c.type === "thinking")?.thinking, "reason-0");
    assert.equal(out[1].content.find((c) => c.type === "toolCall")?.name, "bash");
    assert.equal(out[2].content[0].text, TOOL_OUTPUT_OMITTED);
  });

  it("truncates long tool-call arguments in older sessions", () => {
    const big = "x".repeat(5000);
    const messages = [
      user("bootstrap"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r" },
          { type: "text", text: "writing" },
          {
            type: "toolCall",
            id: "c1",
            name: "write_file",
            arguments: { path: "src/a.rs", content: big },
          },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      },
      toolResult("t1", "done"),
    ];
    const out = compactMessages(messages);
    const tc = out[1].content.find((c) => c.type === "toolCall");
    assert.equal(tc.arguments.path, "src/a.rs");
    assert.ok(tc.arguments.content.length < big.length, "large argument should be truncated");
    assert.ok(tc.arguments.content.includes("truncated"));
  });

  it("drops reasoning from sessions older than the previous one", () => {
    const messages = [
      user("bootstrap"),
      assistant("old-session-reason"),
      toolResult("t1", "A"),
      user(`${COMPACTION_MARKER_PREFIX}1]`),
      assistant("prev-session-reason"),
      toolResult("t2", "B"),
    ];
    const out = compactMessages(messages);
    assert.equal(
      out[1].content.find((c) => c.type === "thinking"),
      undefined,
    );
    assert.equal(
      out[4].content.find((c) => c.type === "thinking")?.thinking,
      "prev-session-reason",
    );
    assert.equal(out[2].content[0].text, TOOL_OUTPUT_OMITTED);
    assert.equal(out[5].content[0].text, TOOL_OUTPUT_OMITTED);
  });

  it("previousSessionStartIndex finds last marker", () => {
    const messages = [
      user("a"),
      user(`${COMPACTION_MARKER_PREFIX}1]`),
      user("b"),
      user(`${COMPACTION_MARKER_PREFIX}2]`),
      user("c"),
    ];
    assert.equal(previousSessionStartIndex(messages), 4);
    assert.equal(previousSessionStartIndex([user("only")]), 0);
  });
});

describe("helpers", () => {
  it("isCompactionMarker recognizes marker user messages", () => {
    assert.equal(
      isCompactionMarker({
        role: "user",
        content: [{ type: "text", text: `${COMPACTION_MARKER_PREFIX}2]` }],
      }),
      true,
    );
    assert.equal(
      isCompactionMarker({ role: "user", content: [{ type: "text", text: "hello" }] }),
      false,
    );
  });

  it("stripAssistantReasoning removes thinking only", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x" },
        { type: "text", text: "y" },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ],
    };
    const out = stripAssistantReasoning(msg);
    assert.deepEqual(
      out.content.map((c) => c.type),
      ["text", "toolCall"],
    );
  });

  it("stripToolResultContent replaces body", () => {
    const out = stripToolResultContent({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "x",
      content: [{ type: "text", text: "big" }],
    });
    assert.equal(out.content[0].text, TOOL_OUTPUT_OMITTED);
    assert.equal(out.toolName, "bash");
  });

  it("buildCompactionUserMessage includes marker and stopReason", () => {
    const text = buildCompactionUserMessage({
      compactionIndex: 2,
      stopReason: "length",
      sandboxSnapshot: "- GOALS.md: missing",
    });
    assert.ok(text.startsWith(`${COMPACTION_MARKER_PREFIX}2]`));
    assert.ok(text.includes("stopReason: length"));
    assert.ok(text.includes("GOALS.md: missing"));
    assert.ok(text.includes("Continue the research task"));
  });

  it("lastAssistantStopReason and lastAssistantReasoning", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "r1" }],
        stopReason: "toolUse",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "r2" }],
        stopReason: "length",
      },
    ];
    assert.equal(lastAssistantStopReason(messages), "length");
    assert.equal(lastAssistantReasoning(messages), "r2");
  });

  it("buildSandboxSnapshot lists GOALS.md and workspace entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-snap-"));
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(
      path.join(tmp, "GOALS.md"),
      "# Task\n### G1 - x [status: done]\n### G2 - y [status: in_progress]\n",
    );
    fs.writeFileSync(path.join(tmp, "src", "apply.rs"), "fn main() {}\n");
    const snap = buildSandboxSnapshot(tmp, fs, path);
    assert.ok(snap.includes("GOALS.md: present (2 goals"));
    assert.ok(snap.includes("done=1"));
    assert.ok(snap.includes("src/apply.rs"));
  });
});

describe("provider error helpers", () => {
  it("detects provider error stops", () => {
    assert.equal(isProviderErrorStop("error"), true);
    assert.equal(isProviderErrorStop("aborted"), true);
    assert.equal(isProviderErrorStop("toolUse"), false);
  });

  it("finds last assistant error detail", () => {
    const messages = [
      { role: "assistant", stopReason: "toolUse" },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "HTTP 502 Bad Gateway",
      },
    ];
    assert.deepEqual(lastAssistantErrorDetail(messages), {
      stopReason: "error",
      errorMessage: "HTTP 502 Bad Gateway",
    });
  });

  it("formats and combines provider errors", () => {
    const entries = [
      { turn: 17, stopReason: "error", errorMessage: "upstream timeout" },
      { turn: 18, stopReason: "error", errorMessage: "HTTP 503" },
    ];
    assert.equal(
      formatProviderErrorSummary(entries),
      "provider errors (2 turns); last at turn 18: HTTP 503",
    );
    const emptyLast = [
      { turn: 17, stopReason: "error", errorMessage: "upstream timeout" },
      { turn: 18, stopReason: "error", errorMessage: null },
    ];
    assert.equal(
      formatProviderErrorSummary(emptyLast),
      "provider errors (2 turns); last at turn 17: upstream timeout",
    );
    assert.equal(
      combineRunErrors("report.json was not written", formatProviderErrorSummary(entries)),
      "report.json was not written; provider errors (2 turns); last at turn 18: HTTP 503",
    );
  });
});
