/**
 * Retry aborted, rate-limited, or transiently-failed LLM turns from the last
 * consistent transcript tail.
 *
 * An aborted / HTTP 429 / transient-provider-error assistant message (or a
 * toolUse turn missing results) is a partial turn. Drop it and call
 * Agent.continue() so the next request replays from the last user or complete
 * tool-result message — never from partial content.
 */

/** @param {string | undefined | null} stopReason */
export function isAbortStop(stopReason) {
  return String(stopReason || "").toLowerCase() === "aborted";
}

/** @param {unknown} error */
export function errorText(error) {
  return typeof error === "string"
    ? error
    : String(error?.message || error || "");
}

/** @param {unknown} error */
export function isAbortError(error) {
  return /\babort/i.test(errorText(error));
}

/** HTTP 429 / provider capacity overload. */
export function isHttp429(error) {
  const text = errorText(error);
  if (!text) return false;
  return (
    /\b429\b/.test(text) ||
    /too many requests/i.test(text) ||
    /overloaded capacity/i.test(text)
  );
}

/** Provider rejected the request because input + max output exceed the context window. */
export function isContextOverflowError(error) {
  const text = errorText(error);
  if (!text) return false;
  return (
    /maximum context length/i.test(text) ||
    /context length/i.test(text) ||
    /too many tokens/i.test(text) ||
    /exceeds the model'?s maximum/i.test(text) ||
    /maximum number of tokens/i.test(text) ||
    /reduce the number of tokens/i.test(text) ||
    // vLLM / OpenAI-compatible servers that refuse to truncate and reject the
    // request instead:
    //   prompt (492952 tokens) + max tokens (32000) exceeds the context (524288);
    //   requests are never truncated. Send a smaller max_tokens ...
    /exceeds the context/i.test(text) ||
    /prompt \(\d+\s*tokens\).*exceeds/i.test(text) ||
    /smaller max[\s_-]?tokens/i.test(text) ||
    /never (be )?truncated/i.test(text) ||
    // OpenCode Go and similar gateways:
    //   [unsupported_request] This text request is too large for the model's
    //   configured input limit.
    /too large for the model/i.test(text) ||
    /input limit/i.test(text) ||
    /request (is )?too large/i.test(text) ||
    /prompt is too long/i.test(text) ||
    /context[_ ]length[_ ]exceeded/i.test(text) ||
    /exceeds? (the )?(model'?s )?context window/i.test(text)
  );
}

/** @param {any} message */
export function isContextOverflowAssistant(message) {
  if (!message || message.role !== "assistant") return false;
  if (String(message.stopReason || "").toLowerCase() !== "error") return false;
  return isContextOverflowError(message.errorMessage);
}

/**
 * Whether the trailing turn failed because the request exceeded the context
 * window and should be retried after compaction.
 * @param {any[]} messages
 * @param {unknown} [caughtError]
 */
export function shouldRetryContextOverflow(messages, caughtError = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role === "assistant") {
      if (isContextOverflowAssistant(msg)) return true;
      break;
    }
  }
  return isContextOverflowError(caughtError);
}

/**
 * A provider failure to wait out with exponential backoff and retry from the
 * last consistent point: every failure except the ones with their own
 * recovery path, i.e. HTTP 429 (rate-limit retry, honours retry-after),
 * context overflow (compaction) and aborts (abort retry; an abort may also
 * mean the session is shutting down). Deliberately broad: providers word
 * temporary trouble in many ways (5xx, dropped streams, "KV pool exhausted"
 * while the GPUs are busy, ...), and a run is supervised, so a genuinely
 * permanent error only costs waiting until the retry budget runs out.
 * @param {unknown} error
 */
export function isTransientProviderError(error) {
  if (error === null || error === undefined) return false;
  const text = errorText(error);
  if (isHttp429(text)) return false;
  if (isContextOverflowError(text)) return false;
  if (isAbortError(text)) return false;
  return true;
}

/** @param {any} message */
export function isTransientProviderAssistant(message) {
  if (!message || message.role !== "assistant") return false;
  if (String(message.stopReason || "").toLowerCase() !== "error") return false;
  return isTransientProviderError(message.errorMessage ?? "");
}

/**
 * Whether the trailing turn failed with a retryable transient provider error.
 * @param {any[]} messages
 * @param {unknown} [caughtError]
 */
export function shouldRetryTransientProviderTurn(messages, caughtError = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") continue;
    return isTransientProviderAssistant(msg);
  }
  return isTransientProviderError(caughtError);
}

/** @param {any} message */
export function assistantToolCallIds(message) {
  if (!message || message.role !== "assistant") return [];
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((c) => c && c.type === "toolCall" && c.id)
    .map((c) => String(c.id));
}

/** @param {any} message */
function assistantStopReason(message) {
  return String(message?.stopReason || "").toLowerCase();
}

/** @param {any} message */
export function isRateLimitAssistant(message) {
  if (!message || message.role !== "assistant") return false;
  if (assistantStopReason(message) !== "error") return false;
  return isHttp429(message.errorMessage);
}

/** @param {any} message */
export function isPartialAssistantTurn(message) {
  if (!message || message.role !== "assistant") return false;
  const reason = assistantStopReason(message);
  if (reason === "aborted" || reason === "pending" || reason === "") return true;
  if (reason === "error" && isHttp429(message.errorMessage)) return true;
  // Some providers/SDK paths surface an abort as stopReason "error" with an
  // abort message (e.g. "This operation was aborted") rather than "aborted".
  if (reason === "error" && isAbortError(message.errorMessage)) return true;
  if (reason === "error" && isContextOverflowError(message.errorMessage)) return true;
  if (reason === "error" && isTransientProviderError(message.errorMessage)) return true;
  if (reason === "tooluse" && assistantToolCallIds(message).length === 0) return true;
  return false;
}

/**
 * True when the trailing assistant + toolResult block is missing results.
 * @param {any[]} messages
 */
export function hasIncompleteTrailingToolTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return false;
  let end = list.length - 1;
  while (end >= 0 && list[end]?.role === "toolResult") end -= 1;
  if (end < 0 || list[end]?.role !== "assistant") return false;
  const assistant = list[end];
  if (assistantStopReason(assistant) !== "tooluse") return false;
  const ids = assistantToolCallIds(assistant);
  if (ids.length === 0) return true;
  const results = list.slice(end + 1).filter((m) => m?.role === "toolResult");
  const got = new Set(results.map((m) => String(m.toolCallId || "")));
  return ids.some((id) => !got.has(id));
}

/**
 * Whether the transcript tail is an aborted/partial turn that should be retried.
 * @param {any[]} messages
 * @param {string | null | undefined} [promptError]
 */
export function shouldRetryAbortedTurn(messages, promptError = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") continue;
    if (isAbortStop(msg.stopReason)) return true;
    if (String(msg.stopReason || "").toLowerCase() === "error" && isAbortError(msg.errorMessage)) {
      return true;
    }
    break;
  }
  if (promptError && isAbortError(promptError) && hasIncompleteTrailingToolTurn(list)) {
    return true;
  }
  return false;
}

/**
 * Whether the transcript tail is an HTTP 429 / overload error to retry.
 * @param {any[]} messages
 * @param {string | null | undefined} [promptError]
 */
export function shouldRetryRateLimitTurn(messages, promptError = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role === "assistant" && isRateLimitAssistant(msg)) return true;
    if (msg?.role === "assistant") break;
  }
  return Boolean(promptError && isHttp429(promptError));
}

/**
 * True when the agent finished on a trailing HTTP 429 that was not recovered.
 * @param {any[]} messages
 * @param {string | null | undefined} [promptError]
 */
export function endsOnRateLimitError(messages, promptError = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role === "assistant") {
      return isRateLimitAssistant(msg);
    }
  }
  return Boolean(promptError && isHttp429(promptError));
}

/**
 * True when the session ended on a provider/partial failure that was not recovered.
 * Recovered runs end on a user message, completed tool results, or a clean stop.
 * @param {any[]} messages
 * @param {string | null | undefined} [promptError]
 */
export function endsOnUnresolvedSessionOutcome(messages, promptError = null) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return Boolean(promptError);
  const last = list[list.length - 1];
  if (last?.role === "user" || last?.role === "toolResult") {
    return Boolean(promptError);
  }
  if (hasIncompleteTrailingToolTurn(list)) return true;
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") break;
    if (isRateLimitAssistant(msg)) return true;
    if (isAbortStop(msg.stopReason)) return true;
    const reason = assistantStopReason(msg);
    if (reason === "error") return true;
    if (reason === "length") return true;
    if (isPartialAssistantTurn(msg)) return true;
    return false;
  }
  return Boolean(promptError);
}

/**
 * Drop trailing partial assistant/tool turns. Leaves a user or complete
 * tool-result tail (or empty).
 * @param {any[]} messages
 * @returns {any[]}
 */
export function trimToLastConsistentMessages(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  while (list.length > 0) {
    const last = list[list.length - 1];
    const role = last?.role;
    if (role === "user") break;
    if (role === "assistant") {
      if (isPartialAssistantTurn(last) || hasIncompleteTrailingToolTurn(list)) {
        list.pop();
        continue;
      }
      break;
    }
    if (role === "toolResult") {
      if (hasIncompleteTrailingToolTurn(list)) {
        let i = list.length - 1;
        while (i >= 0 && list[i]?.role === "toolResult") i -= 1;
        if (i >= 0 && list[i]?.role === "assistant") {
          list.splice(i);
          continue;
        }
        list.pop();
        continue;
      }
      break;
    }
    list.pop();
  }
  return list;
}

/**
 * Last message is a valid Agent.continue() starting point.
 * @param {any[]} messages
 */
export function canContinueFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return false;
  const last = list[list.length - 1];
  return last?.role === "user" || last?.role === "toolResult";
}
