/**
 * Append-only JSONL transcript writer.
 *
 * One file per agent (`/transcripts/<role>.jsonl`), plus a session file written
 * by the control plane. Files live outside the sandbox so they survive sandbox
 * resets and can be tailed by the WebUI.
 *
 * Each line is a self-contained JSON object:
 *   { ts, agent, kind, ...payload }
 * where kind is one of:
 *   - "message"      a serialized agent message (user/assistant/toolResult)
 *   - "system"       retry / compaction / lifecycle note
 *   - "handoff"      an envelope sent to or received from the peer
 *   - "human"        human-in-the-loop message/decision
 *   - "state"        control-plane state transition
 */
import fs from "node:fs";
import path from "node:path";

export function nowMs() {
  return Date.now();
}

/**
 * Serialize a pi AgentMessage into a compact, UI-friendly transcript entry.
 * Mirrors the reference pi-retrieve `serializeMessage`.
 */
export function serializeMessage(message) {
  if (!message) return null;
  const base = { role: message.role, timestamp: message.timestamp };
  if (message.role === "toolResult") {
    base.toolName = message.toolName;
    base.toolCallId = message.toolCallId;
    base.isError = message.isError;
    base.content = (message.content || [])
      .map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`))
      .join("");
    return base;
  }
  if (message.role === "assistant") {
    const textBlocks = [];
    const reasoningBlocks = [];
    const toolCallBlocks = [];
    for (const c of message.content || []) {
      if (c?.type === "text") textBlocks.push(c.text);
      else if (c?.type === "thinking") reasoningBlocks.push(c.thinking || "");
      else if (c?.type === "toolCall")
        toolCallBlocks.push({ id: c.id, name: c.name, arguments: c.arguments || {} });
      else textBlocks.push(`[${c?.type}]`);
    }
    if (textBlocks.length) base.content = textBlocks.join("\n");
    if (reasoningBlocks.length) base.reasoning = reasoningBlocks.join("\n");
    if (toolCallBlocks.length) base.tool_calls = toolCallBlocks;
    base.stopReason = message.stopReason;
    if (message.errorMessage) base.errorMessage = message.errorMessage;
    if (message.usage) base.usage = message.usage;
    return base;
  }
  base.content = Array.isArray(message.content)
    ? message.content.map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("")
    : message.content;
  return base;
}

export function summarizeResult(result) {
  if (!result) return null;
  const texts = (result.content || [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
  return texts.slice(0, 4000) || "(no text)";
}

/**
 * Create a line-buffered JSONL writer. Best-effort: transcript failures must
 * never crash the agent loop.
 *
 * @param {string} filePath
 * @param {string} agent role label ("researcher" | "advisor")
 */
export function createTranscriptWriter(filePath, agent) {
  let fd = null;
  let broken = false;

  const ensure = () => {
    if (broken) return null;
    try {
      if (fd === null) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fd = fs.openSync(filePath, "a");
      }
      return fd;
    } catch {
      broken = true;
      return null;
    }
  };

  return {
    /**
     * @param {string} kind
     * @param {object} payload
     */
    write(kind, payload = {}) {
      // Reserved keys always win over payload fields so callers cannot
      // accidentally clobber the entry type (e.g. a handoff's kind).
      const entry = { ...payload, ts: nowMs(), agent, kind };
      const handle = ensure();
      if (handle === null) return entry;
      try {
        fs.writeSync(handle, JSON.stringify(entry) + "\n");
      } catch {
        broken = true;
      }
      return entry;
    },
    writeMessage(message) {
      const serialized = serializeMessage(message);
      if (!serialized) return;
      this.write("message", serialized);
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
      }
    },
  };
}
