#!/usr/bin/env node
/**
 * Control-plane HTTP server: broker endpoints, SSE transcript stream, WebUI.
 *
 * Binds to 127.0.0.1 only. Mutating endpoints require the session token
 * (x-session-token header or ?token=). The token is embedded in the served UI.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBroker } from "./broker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, "ui", "index.html");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

class TranscriptTailer {
  constructor(dir, files) {
    this.dir = dir;
    this.offsets = new Map(files.map((f) => [f, 0]));
    this.listeners = new Set();
  }
  onData(fn) {
    this.listeners.add(fn);
  }
  emit(entry) {
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        // ignore
      }
    }
  }
  tick() {
    const batch = [];
    for (const file of this.offsets.keys()) {
      const abs = path.join(this.dir, file);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      let offset = this.offsets.get(file);
      if (stat.size < offset) offset = 0; // truncated/rotated
      if (stat.size === offset) continue;
      let text = "";
      try {
        const fd = fs.openSync(abs, "r");
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) continue;
      const complete = text.slice(0, lastNewline);
      this.offsets.set(file, offset + Buffer.byteLength(text.slice(0, lastNewline + 1)));
      for (const line of complete.split("\n")) {
        if (!line.trim()) continue;
        try {
          batch.push(JSON.parse(line));
        } catch {
          // skip malformed
        }
      }
    }
    // Emit the whole tick in chronological order so entries produced by
    // different agents/files around a handoff are not shown out of order.
    batch.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (const entry of batch) this.emit(entry);
  }
  start(intervalMs = 400) {
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.task
 * @param {string} opts.transcriptDir
 * @param {string} opts.sessionId
 * @param {number} [opts.port]
 * @param {number} [opts.maxHandoffs]
 * @param {number} [opts.wallclockMs]
 * @returns {Promise<{ server, broker, port, url, waitForExit }>}
 */
const TRANSCRIPT_FILES = ["researcher.jsonl", "advisor.jsonl", "session.jsonl"];

/**
 * Read every entry currently on disk (up to the tailer's committed offsets),
 * sorted by timestamp, so a newly connected client receives the full transcript
 * (not just the live tail). Reading only up to `offsets` avoids duplicating
 * lines the tailer has not broadcast yet. Called synchronously while handling
 * the SSE request, so no tailer tick can interleave.
 *
 * @param {string} dir
 * @param {Map<string, number>} [offsets]
 */
function readTranscriptHistory(dir, offsets = null) {
  const entries = [];
  for (const file of TRANSCRIPT_FILES) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, file));
    } catch {
      continue;
    }
    const limit = offsets?.get(file);
    const slice = typeof limit === "number" ? buf.subarray(0, limit) : buf;
    for (const line of slice.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  }
  entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return entries;
}

export function startControlPlane(opts) {
  const broker = createBroker({
    token: opts.token,
    task: opts.task,
    transcriptDir: opts.transcriptDir,
    sessionId: opts.sessionId,
    maxHandoffs: opts.maxHandoffs || 0,
    initialNote: opts.initialNote || "",
    skipSkills: opts.skipSkills || false,
    installedSkillsPath: opts.installedSkillsPath || null,
  });

  const tailer = new TranscriptTailer(opts.transcriptDir, TRANSCRIPT_FILES);
  tailer.start();

  const sseClients = new Set();
  broker.events.on("state", (snap) => {
    broadcastSse({ type: "state", state: snap });
  });
  tailer.onData((entry) => broadcastSse({ type: "entry", entry }));

  function broadcastSse(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function authed(req, url) {
    const header = req.headers["x-session-token"];
    const query = url.searchParams.get("token");
    return header === opts.token || query === opts.token;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /" || route === "GET /index.html") {
        // The token is NOT embedded; the UI reads it from the URL query string
        // (the orchestrator opens `/?token=...`). All /api/* routes are authed.
        const html = fs.readFileSync(UI_PATH, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (!authed(req, url)) {
        sendJson(res, 401, { ok: false, error: "invalid session token" });
        return;
      }

      if (route === "GET /api/state") {
        sendJson(res, 200, { ok: true, state: broker.snapshot(), sessionId: opts.sessionId });
        return;
      }

      if (route === "GET /api/goals") {
        let text = "";
        try {
          text = fs.readFileSync(opts.goalsPath, "utf8");
        } catch {
          text = "";
        }
        sendJson(res, 200, { ok: true, goals: text });
        return;
      }

      if (route === "GET /api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "state", state: broker.snapshot() })}\n\n`);
        // Replay the full transcript so far, then subscribe to the live tail.
        // (Ordering matters: history is written before this client is added,
        // and the handler is synchronous, so nothing is missed or duplicated.)
        const history = readTranscriptHistory(opts.transcriptDir, tailer.offsets);
        res.write(`data: ${JSON.stringify({ type: "history", entries: history })}\n\n`);
        sseClients.add(res);
        const keepalive = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            // ignore
          }
        }, 15000);
        req.on("close", () => {
          clearInterval(keepalive);
          sseClients.delete(res);
        });
        return;
      }

      if (route === "POST /api/register") {
        const body = JSON.parse((await readBody(req)) || "{}");
        sendJson(res, 200, broker.register(body.role));
        return;
      }

      if (route === "GET /api/inbox") {
        const role = url.searchParams.get("role");
        const cursor = Number(url.searchParams.get("cursor") || 0);
        const wait = Number(url.searchParams.get("wait") || 25000);
        const result = await broker.poll(role, cursor, wait);
        sendJson(res, 200, result);
        return;
      }

      if (route === "POST /api/message") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = broker.receiveAgentEnvelope(body.role, body.envelope);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (route === "POST /api/event") {
        const body = JSON.parse((await readBody(req)) || "{}");
        broker.events.emit("agent-event", body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === "POST /api/human/decision") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = broker.humanDecision(body);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (route === "POST /api/human/message") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = broker.humanMessage(body.target, body.text, body.payload || {});
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: `not found: ${route}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
  });

  const port = opts.port || 0;

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      const url = `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(opts.token)}`;
      broker.start();
      resolve({
        server,
        broker,
        port: actualPort,
        url,
        tailer,
        close() {
          tailer.stop();
          for (const res of sseClients) {
            try {
              res.end();
            } catch {
              // ignore
            }
          }
          server.close();
        },
      });
    });
  });
}
