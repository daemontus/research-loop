/**
 * How this harness identifies itself to LLM providers that require it.
 *
 * OpenCode (Zen / Go) requires coding harnesses to send a per-session
 * `x-opencode-session` header and to identify themselves (User-Agent plus
 * `x-opencode-client`), mirroring what the Pi coding agent does. pi-ai itself
 * does not add these; they are attached in AgentSession's streamFn.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

export const CLIENT_NAME = "research-loop";

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLIENT_VERSION = readVersion();
export const USER_AGENT = `${CLIENT_NAME}/${CLIENT_VERSION}`;

const OPENCODE_HOST = "opencode.ai";

export function isOpencodeModel(model) {
  if (model?.provider === "opencode" || model?.provider === "opencode-go") return true;
  try {
    const host = new URL(model?.baseUrl || "").hostname;
    return host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`);
  } catch {
    return false;
  }
}

/**
 * A stable, UUID-formatted session id for one agent of one run. Derived from
 * the run's session id and the role, so a resumed run keeps the same
 * provider-side session for each agent.
 */
export function clientSessionId(runSessionId, role) {
  const hex = createHash("sha256").update(`${CLIENT_NAME}:${runSessionId}:${role}`).digest("hex");
  // RFC 9562 UUIDv8 (custom): version nibble 8, variant bits 10.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Extra request headers for `model`'s provider (empty for most providers). */
export function providerRequestHeaders(model, sessionId) {
  if (!isOpencodeModel(model)) return {};
  const headers = { "User-Agent": USER_AGENT, "x-opencode-client": CLIENT_NAME };
  if (sessionId) headers["x-opencode-session"] = sessionId;
  return headers;
}
