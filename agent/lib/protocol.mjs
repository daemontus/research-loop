/**
 * Handoff envelopes shared by the agent runner, control plane, and UI.
 *
 * An agent ends its turn by calling one control tool; the envelope's `kind`
 * is that tool's name (see control-plane/state-machine.mjs for which tool is
 * allowed when, and docs/PROTOCOL.md for the protocol).
 *
 *   {
 *     role: "researcher" | "advisor" | "human" | "control",
 *     kind: string,          // control tool name, or a control/human kind
 *     goalId: string | null,
 *     text: string,          // the sender's final assistant text
 *     payload: object,       // structured control-tool arguments
 *     ts: number,
 *     agentId?: string,      // session this belongs to ("root" by default)
 *     agent?: object,        // session metadata (kind, brief, ...) from the control plane
 *     body?: string,         // markdown rendering of the payload (from the control plane)
 *     next?: string,         // what the receiving agent must do now (from the control plane)
 *     contextOps?: object[], // context operations to apply before the next phase
 *   }
 */
import { CONTROL_TOOL_DEFS } from "./control-tools.mjs";

/** Id of the main (human-supervised) session. */
export const ROOT_AGENT_ID = "root";

/** Every agent control tool. */
export const CONTROL_TOOL_NAMES = new Set(Object.keys(CONTROL_TOOL_DEFS));

export const HUMAN_KINDS = ["human_message", "human_decision"];
export const CONTROL_KINDS = ["start", "prompt", "session_done", "abort", "agent_done", "install_skills"];
/** Sent by an agent process itself (not a model): the harness installer finished. */
export const SYSTEM_KINDS = ["skills_installed"];

export const ALL_KINDS = new Set([...CONTROL_TOOL_NAMES, ...HUMAN_KINDS, ...CONTROL_KINDS, ...SYSTEM_KINDS]);

/**
 * Validate a handoff envelope produced by an agent runner.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: "envelope must be an object" };
  }
  if (!["researcher", "advisor", "human", "control"].includes(envelope.role)) {
    return { ok: false, error: `invalid role: ${envelope.role}` };
  }
  if (!ALL_KINDS.has(envelope.kind)) {
    return { ok: false, error: `invalid kind: ${envelope.kind}` };
  }
  if (envelope.goalId != null && typeof envelope.goalId !== "string") {
    return { ok: false, error: "goalId must be a string or null" };
  }
  if (typeof envelope.text !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  if (envelope.agentId != null && typeof envelope.agentId !== "string") {
    return { ok: false, error: "agentId must be a string or null" };
  }
  return { ok: true };
}

/** Render an inbound envelope into the user prompt handed to the receiving agent. */
export function renderInbound(envelope) {
  const sub = envelope.agentId && envelope.agentId !== ROOT_AGENT_ID ? ` | session=${envelope.agentId}` : "";
  const lines = [
    `[${envelope.role === "human" ? "message from the human" : `handoff from ${envelope.role}`} | ${envelope.kind}` +
      `${envelope.goalId ? ` | goal=${envelope.goalId}` : ""}${sub}]`,
    "",
  ];
  if (envelope.text && envelope.text.trim()) lines.push(envelope.text.trim(), "");
  if (envelope.body && envelope.body.trim()) {
    lines.push(envelope.body.trim(), "");
  } else if (envelope.payload && Object.keys(envelope.payload).length) {
    lines.push("--- structured payload ---", JSON.stringify(envelope.payload, null, 2), "");
  }
  if (envelope.next && envelope.next.trim()) lines.push("--- what to do now ---", envelope.next.trim());
  return lines.join("\n").trim();
}
