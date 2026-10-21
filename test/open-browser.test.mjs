import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { openBrowser } from "../orchestrator/run.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("openBrowser", () => {
  it("invokes the platform opener with the URL", async () => {
    if (process.platform === "win32") return; // cmd/start stub is awkward
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-open-"));
    const marker = path.join(dir, "marker.txt");
    const name = process.platform === "darwin" ? "open" : "xdg-open";
    const opener = path.join(dir, name);
    fs.writeFileSync(opener, `#!/bin/sh\necho "$1" > '${marker}'\n`);
    fs.chmodSync(opener, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      openBrowser("http://example.test/ui");
      const start = Date.now();
      while (!fs.existsSync(marker) && Date.now() - start < 10000) {
        await sleep(50);
      }
      assert.ok(fs.existsSync(marker), "opener should have been invoked");
      assert.equal(fs.readFileSync(marker, "utf8").trim(), "http://example.test/ui");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
