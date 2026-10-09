/**
 * Context compaction for the research-loop agent when it hits a length stop.
 *
 * Compaction rules (applied to AgentMessage[] before restarting the turn loop):
 * 1. Strip all tool-result bodies (any session).
 * 2. Strip thinking/reasoning from every session except the previous one
 *    (messages after the last compaction marker, or all messages if none yet).
 * 3. Inject a compaction user message; the original bootstrap stays in history.
 *
 * The full unredacted transcript is kept separately by the caller.
 */

export const COMPACTION_MARKER_PREFIX = "[context compaction ";

export const TOOL_OUTPUT_OMITTED =
  "[tool output omitted during context compaction; re-run the tool if you still need the data]";

export const TOOL_ARGS_OMITTED = "[older tool-call arguments truncated during context compaction]";

/** Maximum length kept for any single string inside older tool-call arguments. */
const MAX_TOOL_ARG_STRING = 500;

function truncateArgValue(value, maxLen) {
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…${TOOL_ARGS_OMITTED}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateArgValue(v, maxLen));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateArgValue(v, maxLen);
    return out;
  }
  return value;
}

/**
 * Truncate long strings inside an assistant message's tool-call arguments.
 * Large `write_file`/`edit_file` bodies are the main driver of context growth
 * and are otherwise never reclaimed by compaction.
 * @param {any} message
 * @param {number} [maxLen]
 */
export function stripAssistantToolArgs(message, maxLen = MAX_TOOL_ARG_STRING) {
  if (!message || message.role !== "assistant") return message;
  const content = Array.isArray(message.content) ? message.content : [];
  let changed = false;
  const mapped = content.map((c) => {
    if (c?.type === "toolCall" && c.arguments && typeof c.arguments === "object") {
      const truncated = truncateArgValue(c.arguments, maxLen);
      if (JSON.stringify(truncated) !== JSON.stringify(c.arguments)) {
        changed = true;
        return { ...c, arguments: truncated };
      }
    }
    return c;
  });
  return changed ? { ...message, content: mapped } : message;
}

/** @param {string | undefined | null} stopReason */
export function isCompactionTrigger(stopReason) {
  const reason = String(stopReason || "").toLowerCase();
  return reason === "length";
}

/** @param {string | undefined | null} stopReason */
export function isProviderErrorStop(stopReason) {
  const reason = String(stopReason || "").toLowerCase();
  return reason === "error" || reason === "aborted";
}

/** @param {import("@earendil-works/pi-ai").Message | { role?: string, content?: unknown }} message */
export function isCompactionMarker(message) {
  if (!message || message.role !== "user") return false;
  const text = userMessageText(message);
  return text.startsWith(COMPACTION_MARKER_PREFIX);
}

/** @param {{ role?: string, content?: unknown }} message */
export function userMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}

/**
 * Index of the first message belonging to the previous session
 * (after the last compaction marker). If no marker exists, the whole history
 * is the previous session → returns 0.
 *
 * @param {unknown[]} messages
 */
export function previousSessionStartIndex(messages) {
  let lastMarker = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isCompactionMarker(messages[i])) lastMarker = i;
  }
  return lastMarker === -1 ? 0 : lastMarker + 1;
}

/**
 * Strip tool-result bodies; keep toolName / toolCallId / isError.
 * @param {any} message
 */
export function stripToolResultContent(message) {
  if (!message || message.role !== "toolResult") return message;
  return {
    ...message,
    content: [{ type: "text", text: TOOL_OUTPUT_OMITTED }],
  };
}

/**
 * Remove thinking blocks from an assistant message.
 * @param {any} message
 */
export function stripAssistantReasoning(message) {
  if (!message || message.role !== "assistant") return message;
  const content = Array.isArray(message.content) ? message.content : [];
  const filtered = content.filter((c) => c?.type !== "thinking");
  if (filtered.length === content.length) return message;
  return { ...message, content: filtered };
}

/**
 * Compact conversation for a new session after a length stop.
 *
 * @param {any[]} messages
 * @returns {any[]}
 */
export function compactMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const keepReasoningFrom = previousSessionStartIndex(list);
  return list.map((msg, index) => {
    // Tool-call arguments (file bodies, etc.) are truncated for every session:
    // they are the dominant source of unbounded growth and are recoverable from
    // the workspace. Reasoning is only dropped from sessions older than the
    // previous one.
    let next = stripToolResultContent(msg);
    next = stripAssistantToolArgs(next);
    if (index < keepReasoningFrom) {
      next = stripAssistantReasoning(next);
    }
    return next;
  });
}

/**
 * @param {object} opts
 * @param {number} opts.compactionIndex 1-based compaction count
 * @param {string} opts.stopReason
 * @param {string} [opts.sandboxSnapshot]
 * @param {string} [opts.partialReasoning]
 */
export function buildCompactionUserMessage({
  compactionIndex,
  stopReason,
  sandboxSnapshot = "",
  partialReasoning = "",
}) {
  const lines = [
    `${COMPACTION_MARKER_PREFIX}${compactionIndex}]`,
    "",
    "Context compaction occurred.",
    "",
    `The previous session stopped because of an output/context limit (stopReason: ${stopReason}).`,
    "Tool outputs were removed from chat history to free context. Files on disk are",
    "unchanged — inspect GOALS.md and the workspace before re-running tools.",
    "Reasoning from sessions older than the previous one was also dropped.",
    "",
    "Continue the research task. Consult the goal snapshot below and the current",
    "GOALS.md status. Do not restate completed goals; pick up the in-progress goal.",
  ];
  if (sandboxSnapshot && String(sandboxSnapshot).trim()) {
    lines.push("", "Workspace snapshot:", String(sandboxSnapshot).trim());
  }
  if (partialReasoning && String(partialReasoning).trim()) {
    const clipped = String(partialReasoning).trim().slice(0, 8000);
    lines.push(
      "",
      "Partial reasoning from the interrupted turn (may be incomplete):",
      clipped,
    );
  }
  return lines.join("\n");
}

/**
 * Summarize the workspace for the compaction prompt: GOALS.md status plus a
 * shallow listing of top-level entries (bounded).
 *
 * @param {string} sandbox
 * @param {typeof import("node:fs")} fs
 * @param {typeof import("node:path")} path
 * @param {string} [goalsPath] explicit GOALS.md path (e.g. the advisor's read-only copy)
 */
export function buildSandboxSnapshot(sandbox, fs, path, goalsPath = null) {
  const lines = [];

  const resolvedGoalsPath = goalsPath || path.join(sandbox, "GOALS.md");
  if (fs.existsSync(resolvedGoalsPath)) {
    try {
      const raw = fs.readFileSync(resolvedGoalsPath, "utf8");
      const goalLines = raw.split(/\r?\n/).filter((l) => /^###\s/.test(l));
      const statuses = {};
      for (const line of goalLines) {
        const match = line.match(/\[status:\s*([a-z_]+)\]/i);
        const status = match ? match[1].toLowerCase() : "unknown";
        statuses[status] = (statuses[status] || 0) + 1;
      }
      const summary = Object.entries(statuses)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- GOALS.md: present (${goalLines.length} goals${summary ? `; ${summary}` : ""})`);
    } catch {
      lines.push("- GOALS.md: present but unreadable");
    }
  } else {
    lines.push("- GOALS.md: missing");
  }

  const entries = [];
  const walk = (dir, base, depth) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === "__MACOSX") continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const rel = path.relative(base, abs).replace(/\\/g, "/");
      if (st.isDirectory()) {
        entries.push(`${rel}/`);
        walk(abs, base, depth + 1);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(sandbox, sandbox, 0);
  if (entries.length === 0) {
    lines.push("- workspace: empty");
  } else {
    const shown = entries.slice(0, 60);
    lines.push(`- workspace (${entries.length} entries): ${shown.join(", ")}`);
    if (entries.length > shown.length) {
      lines.push(`  … and ${entries.length - shown.length} more`);
    }
  }
  return lines.join("\n");
}

/**
 * Extract thinking text from the last assistant message (for the compaction note).
 * @param {any[]} messages
 */
export function lastAssistantReasoning(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const parts = [];
    for (const c of msg.content || []) {
      if (c?.type === "thinking" && c.thinking) parts.push(c.thinking);
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Last assistant stopReason in a message list.
 * @param {any[]} messages
 */
export function lastAssistantStopReason(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.stopReason) return msg.stopReason;
  }
  return null;
}

/**
 * Last assistant turn that ended with provider error/aborted.
 * @param {any[]} messages
 * @returns {{ stopReason: string, errorMessage: string | null } | null}
 */
export function lastAssistantErrorDetail(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (!isProviderErrorStop(msg.stopReason)) continue;
    return {
      stopReason: String(msg.stopReason),
      errorMessage: msg.errorMessage ? String(msg.errorMessage) : null,
    };
  }
  return null;
}

/**
 * @param {Array<{ turn?: number, stopReason?: string, errorMessage?: string | null }>} providerErrors
 * @param {{ stopReason?: string, errorMessage?: string | null, turn?: number } | null} [latest]
 */
export function formatProviderErrorSummary(providerErrors, latest = null) {
  const entries = Array.isArray(providerErrors) ? providerErrors : [];
  let last = latest || (entries.length ? entries[entries.length - 1] : null);
  if (entries.length) {
    const withMessage = [...entries].reverse().find((e) => e?.errorMessage);
    if (withMessage) last = withMessage;
  }
  if (!last) return null;
  const detail = last.errorMessage || last.stopReason || "unknown";
  const turn = last.turn != null ? ` at turn ${last.turn}` : "";
  if (entries.length > 1) {
    return `provider errors (${entries.length} turns); last${turn}: ${detail}`;
  }
  return `provider ${last.stopReason || "error"}${turn}: ${detail}`;
}

/**
 * @param {string | null | undefined} baseError
 * @param {string | null | undefined} providerSummary
 */
export function combineRunErrors(baseError, providerSummary) {
  const base = String(baseError || "").trim();
  const provider = String(providerSummary || "").trim();
  if (base && provider) return `${base}; ${provider}`;
  return base || provider || null;
}
