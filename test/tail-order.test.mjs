import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { startControlPlane } from "../control-plane/server.mjs";

describe("live tail ordering", () => {
  it("emits a tick's entries in timestamp order across files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-order-"));
    const transcriptDir = path.join(tmp, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const cp = await startControlPlane({
      token: "t",
      task: "x",
      transcriptDir,
      sessionId: "s",
      goalsPath: path.join(tmp, "GOALS.md"),
      port: 0,
    });

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${cp.port}/api/stream?token=t`, { signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();

    // Let the tailer establish a baseline before we append.
    await new Promise((r) => setTimeout(r, 600));

    // Append out of order across files: researcher (ts=200) is written first,
    // advisor (ts=100) second. A per-file tail would emit 200 then 100.
    fs.appendFileSync(
      path.join(transcriptDir, "researcher.jsonl"),
      JSON.stringify({ ts: 200, agent: "researcher", kind: "system", content: "ORDER-R200" }) + "\n",
    );
    fs.appendFileSync(
      path.join(transcriptDir, "advisor.jsonl"),
      JSON.stringify({ ts: 100, agent: "advisor", kind: "system", content: "ORDER-A100" }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 900));
    ac.abort();
    await pump;

    const iA = text.indexOf("ORDER-A100");
    const iR = text.indexOf("ORDER-R200");
    assert.ok(iA !== -1 && iR !== -1, "both entries should be streamed");
    assert.ok(iA < iR, "advisor ts=100 should arrive before researcher ts=200");

    cp.close();
  });
});
