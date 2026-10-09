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
    async register() {
      return jsonFetch(`${base}/api/register`, {
        method: "POST",
        body: JSON.stringify({ role }),
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
