#!/usr/bin/env node
/**
 * Control-plane HTTP server: broker endpoints, SSE transcript stream, WebUI.
 *
 * Binds to 127.0.0.1 by default (configurable via opts.host). Mutating endpoints
 * require the session token (x-session-token header or ?token=). The token is
 * embedded in the served UI.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBroker } from "./broker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, "ui", "index.html");
const VENDOR_PATH = path.join(__dirname, "ui", "vendor");

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

/** Subagent transcripts: `agents/<id>/<role>.jsonl` under the transcript dir. */
function subagentTranscriptFiles(dir) {
  const files = [];
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(dir, "agents"), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of ids) {
    if (!ent.isDirectory()) continue;
    for (const role of ["researcher", "advisor"]) {
      const rel = path.join("agents", ent.name, `${role}.jsonl`);
      if (fs.existsSync(path.join(dir, rel))) files.push(rel);
    }
  }
  return files;
}

class TranscriptTailer {
  constructor(dir, files) {
    this.dir = dir;
    this.offsets = new Map(files.map((f) => [f, 0]));
    this.listeners = new Set();
  }
  /** Pick up transcript files created since the last call (new subagents). */
  discover() {
    for (const file of subagentTranscriptFiles(this.dir)) {
      if (!this.offsets.has(file)) this.offsets.set(file, 0);
    }
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
    this.discover();
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
 * @param {string} [opts.label] short run name shown in the WebUI title/header
 * @param {string} opts.transcriptDir
 * @param {string} opts.sessionId
 * @param {string} [opts.host]   bind address (default 127.0.0.1)
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
  // Only files the tailer knows about: a newer file is read from 0 by its next
  // tick, so reading it here too would duplicate its entries.
  const files = offsets ? [...offsets.keys()] : [...TRANSCRIPT_FILES, ...subagentTranscriptFiles(dir)];
  for (const file of files) {
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
    initialState: opts.initialState || null,
    initialResearcherSteps: opts.initialResearcherSteps || 0,
    initialAgents: opts.initialAgents || null,
    initialActiveId: opts.initialActiveId || null,
    initialRootPendingProposal: opts.initialRootPendingProposal || null,
    initialRootLastPlanExecution: opts.initialRootLastPlanExecution || null,
    researcherSandbox: opts.researcherSandbox || (opts.goalsPath ? path.dirname(opts.goalsPath) : null),
    agentsDir: opts.agentsDir || null,
    maxSubagentDepth: opts.maxSubagentDepth ?? null,
    delegation: opts.delegation || "optional",
  });
  const researcherSandbox =
    opts.researcherSandbox || (opts.goalsPath ? path.dirname(opts.goalsPath) : null);

  /** GOALS.md of the root (default) or of a subagent. */
  function goalsPathFor(agentId) {
    if (!agentId || agentId === "root") return opts.goalsPath;
    if (!/^[A-Za-z0-9_-]+$/.test(agentId) || !researcherSandbox) return null;
    return path.join(researcherSandbox, "agents", agentId, "GOALS.md");
  }

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

      // Vendored third-party UI assets (e.g. the CommonMark renderer): served
      // unauthenticated like the page itself, strict path-traversal check.
      if (route.startsWith("GET /vendor/")) {
        const name = path.basename(decodeURIComponent(url.pathname.slice("/vendor/".length)));
        if (!name || name !== url.pathname.slice("/vendor/".length)) {
          sendJson(res, 400, { ok: false, error: "bad vendor path" });
          return;
        }
        const file = path.join(VENDOR_PATH, name);
        if (name.includes("/") || name.includes("\\") || !fs.existsSync(file) || path.dirname(file) !== path.resolve(VENDOR_PATH)) {
          sendJson(res, 404, { ok: false, error: `not found: ${route}` });
          return;
        }
        const ct = name.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
        res.writeHead(200, { "content-type": ct });
        res.end(fs.readFileSync(file));
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
          text = fs.readFileSync(goalsPathFor(url.searchParams.get("agent")), "utf8");
        } catch {
          text = "";
        }
        sendJson(res, 200, { ok: true, goals: text });
        return;
      }

      // Subagent metadata: instructions, status and (when finished) report.
      if (route === "GET /api/agent") {
        const info = broker.agentInfo(url.searchParams.get("agent") || "root");
        sendJson(res, info ? 200 : 404, info ? { ok: true, agent: info } : { ok: false, error: "unknown agent" });
        return;
      }

      if (route === "GET /api/task") {
        sendJson(res, 200, { ok: true, task: opts.task ?? "", label: opts.label ?? "" });
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

      // Live, in-progress assistant output for the UI. Relayed to SSE clients
      // only; never persisted (the finished message lands in the transcript).
      if (route === "POST /api/partial") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (body.role !== "researcher" && body.role !== "advisor") {
          sendJson(res, 400, { ok: false, error: `invalid role: ${body.role}` });
          return;
        }
        const ops = Array.isArray(body.ops) ? body.ops : [];
        const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "root";
        if (ops.length) broadcastSse({ type: "partial", agent: body.role, agentId, ops });
        sendJson(res, 200, { ok: true });
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
        const result = broker.humanMessage(body.target, body.text, body.payload || {}, body.agentId || null);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: `not found: ${route}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
  });

  const port = opts.port || 0;

  const host = opts.host || "127.0.0.1";
  // A wildcard bind is not a browsable address; print/return a concrete one.
  const urlHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const url = `http://${urlHost}:${actualPort}/?token=${encodeURIComponent(opts.token)}`;
      // View-only mode (e.g. --view a finished run) must not deliver the start
      // message or touch agents; just seed the final state for display.
      if (!opts.viewOnly) broker.start();
      if (opts.seedState) {
        broker.seed(opts.seedState, { agents: opts.seedAgents || null, activeId: opts.seedActiveId || null });
      }
      const extraServers = [];
      resolve({
        server,
        broker,
        host,
        port: actualPort,
        url,
        tailer,
        /**
         * Also serve on another local address (same port, same handler), e.g.
         * the Docker bridge gateway so Linux containers can reach a
         * loopback-bound control plane.
         */
        listenAlso(extraHost) {
          return new Promise((res, rej) => {
            const extra = http.createServer(server.listeners("request")[0]);
            extra.once("error", rej);
            extra.listen(actualPort, extraHost, () => {
              extraServers.push(extra);
              res();
            });
          });
        },
        close() {
          tailer.stop();
          for (const extra of extraServers) extra.close();
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
