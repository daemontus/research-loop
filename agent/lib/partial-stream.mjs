/**
 * Live streaming of in-progress assistant output (thinking/text deltas) to the
 * control plane, purely for display in the WebUI.
 *
 * Deltas are batched and flushed every `intervalMs`; batches are sent strictly
 * in order (one request in flight at a time). Delivery is best-effort: a failed
 * send is dropped, since the finished message always lands in the transcript.
 *
 * Ops sent to the control plane:
 *   { op: "start", id }                      a new assistant message began
 *   { op: "delta", id, channel, text }       channel: "thinking" | "text"
 *   { op: "tool", id, name }                 the model started a tool call
 *   { op: "end", id }                        the message finished (any reason)
 */
export function createPartialStreamer(send, { intervalMs = 250 } = {}) {
  let msgId = 0;
  let active = false;
  let pending = [];
  let timer = null;
  let chain = Promise.resolve();

  function push(op) {
    const last = pending[pending.length - 1];
    if (
      op.op === "delta" &&
      last?.op === "delta" &&
      last.id === op.id &&
      last.channel === op.channel
    ) {
      last.text += op.text;
    } else {
      pending.push(op);
    }
    if (!timer) timer = setTimeout(flush, intervalMs);
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return chain;
    const ops = pending;
    pending = [];
    chain = chain.then(() => send(ops)).catch(() => {});
    return chain;
  }

  function start() {
    msgId += 1;
    active = true;
    push({ op: "start", id: msgId });
  }

  return {
    start,
    delta(channel, text) {
      if (!text) return;
      if (!active) start();
      push({ op: "delta", id: msgId, channel, text });
    },
    tool(name) {
      if (!active) start();
      push({ op: "tool", id: msgId, name: String(name || "") });
    },
    end() {
      if (!active) return chain;
      active = false;
      push({ op: "end", id: msgId });
      return flush();
    },
    flush,
  };
}

/**
 * Feed a pi-agent-core event into the streamer. Only assistant messages are
 * streamed; everything else is ignored.
 */
export function streamAgentEvent(streamer, event) {
  if (!streamer || event?.message?.role !== "assistant") return;
  if (event.type === "message_start") {
    streamer.start();
  } else if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e?.type === "thinking_delta") streamer.delta("thinking", e.delta);
    else if (e?.type === "text_delta") streamer.delta("text", e.delta);
    else if (e?.type === "toolcall_start") {
      const block = e.partial?.content?.[e.contentIndex];
      streamer.tool(block?.name || "");
    }
  } else if (event.type === "message_end") {
    streamer.end();
  }
}
