/**
 * HTTP client for the host control-plane broker.
 *
 * The agent runs inside a container and reaches the broker via
 * host.docker.internal. Inbox delivery uses long-polling so the container
 * stays alive without websocket reconnection logic.
 */
export function createBrokerClient({ brokerUrl, role, token }) {
  const base = String(brokerUrl || "").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    "x-session-token": token || "",
    "x-agent-role": role,
  };

  async function jsonFetch(url, init) {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`broker ${init?.method || "GET"} ${url} -> ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    /** @param {{ codeHash?: string }} [info] fingerprint of the agent code (code-hash.mjs) */
    async register(info = {}) {
      return jsonFetch(`${base}/api/register`, {
        method: "POST",
        body: JSON.stringify({ role, codeHash: info.codeHash ?? null }),
      });
    },

    /**
     * Long-poll for inbox messages. Returns { cursor, messages }.
     * @param {number} cursor
     * @param {number} [waitMs]
     */
    async poll(cursor, waitMs = 25000) {
      const url = `${base}/api/inbox?role=${encodeURIComponent(role)}&cursor=${cursor}&wait=${waitMs}`;
      return jsonFetch(url, { method: "GET" });
    },

    async send(envelope) {
      const res = await fetch(`${base}/api/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({ role, envelope }),
      });
      // A 409 means the handoff was rejected by the state machine. The broker
      // has already queued a correction prompt for us, so this is not fatal:
      // return the structured rejection and let the session loop continue.
      if (res.status === 409) {
        try {
          return await res.json();
        } catch {
          return { ok: false, error: "handoff rejected (unparseable response)" };
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`broker POST /api/message -> ${res.status}: ${body.slice(0, 300)}`);
      }
      return res.json();
    },

    /** The goal tree ({ goals, markdown }). */
    async goals() {
      return jsonFetch(`${base}/api/goals`, { method: "GET" });
    },

    /** One goal in full ({ ok, goal } or { ok: false, error }). */
    async goal(id) {
      const res = await fetch(`${base}/api/goal?id=${encodeURIComponent(id)}`, { headers });
      return res.json().catch(() => ({ ok: false, error: `broker GET /api/goal -> ${res.status}` }));
    },

    /** Best-effort live output for the WebUI (not persisted, never throws). */
    async partial(ops, agentId = null) {
      try {
        return await jsonFetch(`${base}/api/partial`, {
          method: "POST",
          body: JSON.stringify({ role, ops, agentId }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return null;
      }
    },

    async event(type, payload = {}) {
      try {
        return await jsonFetch(`${base}/api/event`, {
          method: "POST",
          body: JSON.stringify({ role, type, payload }),
        });
      } catch {
        return null;
      }
    },
  };
}
