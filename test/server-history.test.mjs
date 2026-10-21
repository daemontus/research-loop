import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { startControlPlane } from "../control-plane/server.mjs";

async function readStream(url, { until, timeoutMs = 3000 } = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (until && until(text)) break;
    }
  } catch {
    // aborted after timeout
  } finally {
    clearTimeout(timer);
  }
  return text;
}

describe("control-plane SSE history", () => {
  it("replays transcript entries written before the client connects", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-history-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({
      token: "t",
      task: "task",
      transcriptDir,
      sessionId: "s",
      port: 0,
    });

    // Entries that exist before any UI connects.
    fs.appendFileSync(
      path.join(transcriptDir, "researcher.jsonl"),
      JSON.stringify({ ts: 1, agent: "researcher", kind: "system", content: "EARLY-SYSTEM" }) + "\n",
    );
    fs.appendFileSync(
      path.join(transcriptDir, "researcher.jsonl"),
      JSON.stringify({
        ts: 2,
        agent: "researcher",
        kind: "handoff",
        direction: "out",
        handoffKind: "proposal",
        goalId: "G1",
        text: "EARLY-PROPOSAL",
        payload: { plan: ["a"] },
      }) + "\n",
    );

    // Give the tailer zero-to-one tick so offsets may or may not include them;
    // either way the client must receive them exactly once via history+live.
    const text = await readStream(`http://127.0.0.1:${cp.port}/api/stream?token=t`, {
      until: (t) => t.includes("EARLY-SYSTEM") && t.includes("EARLY-PROPOSAL"),
    });

    assert.ok(text.includes("EARLY-SYSTEM"), "history should include early system entry");
    assert.ok(text.includes("EARLY-PROPOSAL"), "history should include early handoff entry");
    // The handoff entry's type must not have been clobbered by its payload kind.
    assert.ok(text.includes('"kind":"handoff"'), "handoff entry kind preserved");
    assert.ok(text.includes('"handoffKind":"proposal"'), "handoff kind preserved separately");

    cp.close();
  });

  it("requires the session token for /api/* routes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-auth-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({
      token: "secret",
      task: "x",
      transcriptDir,
      sessionId: "s",
      port: 0,
    });
    const base = `http://127.0.0.1:${cp.port}`;
    assert.equal((await fetch(`${base}/api/stream`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/goals`)).status, 401);
    assert.equal((await fetch(`${base}/api/state?token=secret`)).status, 200);
    // The root page is served but does not embed the token.
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(!html.includes("secret"));
    cp.close();
  });

  it("binds to the requested host and reports it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-host-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({
      token: "t",
      task: "x",
      transcriptDir,
      sessionId: "s",
      host: "127.0.0.1",
      port: 0,
    });
    assert.equal(cp.host, "127.0.0.1");
    assert.ok(
      cp.url.startsWith(`http://127.0.0.1:${cp.port}/`),
      `url should use the requested host, got ${cp.url}`,
    );
    cp.close();
  });

  it("uses a browsable host in the URL when bound to a wildcard", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-wildcard-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({
      token: "t",
      task: "x",
      transcriptDir,
      sessionId: "s",
      host: "0.0.0.0",
      port: 0,
    });
    assert.equal(cp.host, "0.0.0.0");
    assert.ok(
      cp.url.startsWith(`http://127.0.0.1:${cp.port}/`),
      `wildcard bind should print a browsable host, got ${cp.url}`,
    );
    // The UI is still reachable via loopback when bound to 0.0.0.0.
    assert.equal((await fetch(`http://127.0.0.1:${cp.port}/api/state?token=t`)).status, 200);
    cp.close();
  });
});
