import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assistantToolCallIds,
  canContinueFromMessages,
  endsOnRateLimitError,
  endsOnUnresolvedSessionOutcome,
  hasIncompleteTrailingToolTurn,
  isAbortError,
  isAbortStop,
  isHttp429,
  isPartialAssistantTurn,
  isRateLimitAssistant,
  isTransientProviderAssistant,
  isTransientProviderError,
  shouldRetryAbortedTurn,
  shouldRetryRateLimitTurn,
  shouldRetryTransientProviderTurn,
  trimToLastConsistentMessages,
} from "../agent/lib/abort-retry.mjs";

const user = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const assistant = ({
  stopReason = "toolUse",
  text = "ok",
  tools = [],
  thinking,
  errorMessage,
} = {}) => ({
  role: "assistant",
  content: [
    ...(thinking ? [{ type: "thinking", thinking }] : []),
    ...(text ? [{ type: "text", text }] : []),
    ...tools.map((t) => ({
      type: "toolCall",
      id: t.id,
      name: t.name || "bash",
      arguments: t.arguments || {},
    })),
  ],
  stopReason,
  errorMessage:
    errorMessage ??
    (stopReason === "aborted" ? "Request was aborted" : undefined),
  timestamp: 1,
});

const toolResult = (id, text = "out") => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  isError: false,
  content: [{ type: "text", text }],
  timestamp: 1,
});

describe("abort stop helpers", () => {
  it("detects aborted stopReason and abort errors", () => {
    assert.equal(isAbortStop("aborted"), true);
    assert.equal(isAbortStop("ABORTED"), true);
    assert.equal(isAbortStop("length"), false);
    assert.equal(isAbortError("Request was aborted"), true);
    assert.equal(isAbortError(new Error("This operation was aborted")), true);
    assert.equal(isAbortError("HTTP 502"), false);
  });

  it("detects HTTP 429 / overload messages", () => {
    assert.equal(isHttp429("HTTP 429 Too Many Requests"), true);
    assert.equal(isHttp429("status code 429"), true);
    assert.equal(isHttp429("overloaded capacity"), true);
    assert.equal(isHttp429("HTTP 502 Bad Gateway"), false);
    const limited = assistant({
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
    });
    assert.equal(isRateLimitAssistant(limited), true);
    assert.equal(isPartialAssistantTurn(limited), true);
    assert.equal(
      isRateLimitAssistant(
        assistant({ stopReason: "error", errorMessage: "HTTP 502 Bad Gateway" }),
      ),
      false,
    );
  });

  it("treats aborted assistants as partial turns", () => {
    assert.equal(isPartialAssistantTurn(assistant({ stopReason: "aborted" })), true);
    assert.equal(isPartialAssistantTurn(assistant({ stopReason: "stop" })), false);
    assert.equal(
      isPartialAssistantTurn(
        assistant({ stopReason: "toolUse", tools: [{ id: "t1" }] }),
      ),
      false,
    );
  });

  it("treats abort-encoded-as-error as a retryable partial turn", () => {
    const abortedAsError = assistant({
      stopReason: "error",
      errorMessage: "This operation was aborted",
    });
    assert.equal(isPartialAssistantTurn(abortedAsError), true);
    assert.equal(shouldRetryAbortedTurn([user("go"), abortedAsError]), true);

    const out = trimToLastConsistentMessages([user("go"), abortedAsError]);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user"],
    );
  });
});

describe("trimToLastConsistentMessages", () => {
  it("drops a trailing aborted assistant and keeps the user prompt", () => {
    const messages = [user("go"), assistant({ stopReason: "aborted", thinking: "half" })];
    const out = trimToLastConsistentMessages(messages);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user"],
    );
    assert.equal(canContinueFromMessages(out), true);
  });

  it("drops aborted follow-up after a complete tool turn", () => {
    const messages = [
      user("go"),
      assistant({ tools: [{ id: "t1" }] }),
      toolResult("t1"),
      assistant({ stopReason: "aborted", text: "partial" }),
    ];
    const out = trimToLastConsistentMessages(messages);
    assert.equal(out.at(-1)?.role, "toolResult");
    assert.equal(out.at(-1)?.toolCallId, "t1");
    assert.equal(canContinueFromMessages(out), true);
    assert.equal(shouldRetryAbortedTurn(messages), true);
  });

  it("drops an incomplete toolUse turn including partial tool results", () => {
    const messages = [
      user("go"),
      assistant({ tools: [{ id: "t1" }, { id: "t2" }] }),
      toolResult("t1"),
    ];
    assert.equal(hasIncompleteTrailingToolTurn(messages), true);
    const out = trimToLastConsistentMessages(messages);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user"],
    );
  });

  it("keeps a completed tool turn", () => {
    const messages = [
      user("go"),
      assistant({ tools: [{ id: "t1" }] }),
      toolResult("t1"),
    ];
    const out = trimToLastConsistentMessages(messages);
    assert.equal(out.length, 3);
    assert.equal(hasIncompleteTrailingToolTurn(out), false);
  });

  it("does not retry a clean stop", () => {
    const messages = [user("go"), assistant({ stopReason: "stop" })];
    assert.equal(shouldRetryAbortedTurn(messages), false);
    assert.equal(trimToLastConsistentMessages(messages).length, 2);
    assert.equal(canContinueFromMessages(messages), false);
  });

  it("retries incomplete tools when the prompt error is an abort", () => {
    const messages = [
      user("go"),
      assistant({ tools: [{ id: "t1" }, { id: "t2" }] }),
      toolResult("t1"),
    ];
    assert.equal(shouldRetryAbortedTurn(messages, "Request was aborted"), true);
    assert.equal(shouldRetryAbortedTurn(messages, "HTTP 502"), false);
  });

  it("drops a trailing HTTP 429 error assistant for retry", () => {
    const messages = [
      user("go"),
      assistant({ tools: [{ id: "t1" }] }),
      toolResult("t1"),
      assistant({
        stopReason: "error",
        errorMessage: "HTTP 429 Too Many Requests",
      }),
    ];
    assert.equal(shouldRetryRateLimitTurn(messages), true);
    assert.equal(shouldRetryRateLimitTurn(messages.slice(0, 3), "HTTP 502"), false);
    const out = trimToLastConsistentMessages(messages);
    assert.equal(out.at(-1)?.role, "toolResult");
    assert.equal(canContinueFromMessages(out), true);
  });

  it("detects terminal HTTP 429 on the trailing assistant", () => {
    const messages = [
      user("go"),
      assistant({
        stopReason: "error",
        errorMessage: "HTTP 429 Too Many Requests",
      }),
    ];
    assert.equal(endsOnRateLimitError(messages), true);
    assert.equal(endsOnUnresolvedSessionOutcome(messages), true);
    assert.equal(
      endsOnUnresolvedSessionOutcome([
        user("go"),
        assistant({ stopReason: "stop", content: "done" }),
      ]),
      false,
    );
  });

  it("detects other unresolved terminal outcomes", () => {
    assert.equal(
      endsOnUnresolvedSessionOutcome([
        user("go"),
        assistant({ stopReason: "aborted", errorMessage: "Request was aborted" }),
      ]),
      true,
    );
    assert.equal(
      endsOnUnresolvedSessionOutcome([
        user("go"),
        assistant({
          stopReason: "error",
          errorMessage: "HTTP 502 Bad Gateway",
        }),
      ]),
      true,
    );
    assert.equal(
      endsOnUnresolvedSessionOutcome([
        user("go"),
        assistant({ tools: [{ id: "t1" }] }),
        toolResult("t1"),
      ]),
      false,
    );
  });

  it("collects tool call ids", () => {
    const msg = assistant({ tools: [{ id: "a" }, { id: "b" }] });
    assert.deepEqual(assistantToolCallIds(msg), ["a", "b"]);
  });
});

describe("transient provider errors", () => {
  it("classifies transport drops as retryable but not 429/context-overflow/limits", () => {
    assert.equal(isTransientProviderError("terminated"), true);
    assert.equal(isTransientProviderError("socket hang up"), true);
    assert.equal(isTransientProviderError("fetch failed"), true);
    assert.equal(isTransientProviderError("HTTP 502 Bad Gateway"), true);
    assert.equal(isTransientProviderError("HTTP 429 Too Many Requests"), false);
    assert.equal(isTransientProviderError("overloaded capacity"), false);
    assert.equal(isTransientProviderError("maximum context length exceeded"), false);
    assert.equal(isTransientProviderError("Please reduce the number of tokens."), false);
    assert.equal(isTransientProviderError("Monthly usage limit reached"), false);
    assert.equal(isTransientProviderError("This operation was aborted"), false);
    assert.equal(isTransientProviderError("HTTP 400 Bad Request"), false);
  });

  it("treats a trailing terminated assistant as a retryable partial turn", () => {
    const dropped = assistant({ stopReason: "error", errorMessage: "terminated" });
    assert.equal(isTransientProviderAssistant(dropped), true);
    assert.equal(isPartialAssistantTurn(dropped), true);
    assert.equal(shouldRetryTransientProviderTurn([user("go"), dropped]), true);

    const out = trimToLastConsistentMessages([user("go"), dropped]);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user"],
    );
    assert.equal(canContinueFromMessages(out), true);
  });

  it("does not treat 429 or context-overflow as transient", () => {
    const limited = assistant({
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
    });
    assert.equal(isTransientProviderAssistant(limited), false);
    assert.equal(shouldRetryTransientProviderTurn([user("go"), limited]), false);

    const overflow = assistant({
      stopReason: "error",
      errorMessage: "Please reduce the number of tokens.",
    });
    assert.equal(isTransientProviderAssistant(overflow), false);
    assert.equal(shouldRetryTransientProviderTurn([user("go"), overflow]), false);
  });

  it("falls back to the caught error when no assistant message exists", () => {
    assert.equal(shouldRetryTransientProviderTurn([user("go")], "terminated"), true);
    assert.equal(
      shouldRetryTransientProviderTurn([user("go")], "HTTP 400 Bad Request"),
      false,
    );
  });
});
