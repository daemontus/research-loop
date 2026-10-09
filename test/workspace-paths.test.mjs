import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listReadableDir,
  readReadableFile,
  resolveReadablePath,
} from "../agent/lib/workspace-paths.mjs";

test("resolveReadablePath allows sandbox, config, and prefetch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-paths-"));
  const sandbox = path.join(tmp, "sandbox");
  const config = path.join(tmp, "config");
  const prefetch = path.join(tmp, "prefetch");
  fs.mkdirSync(sandbox);
  fs.mkdirSync(config);
  fs.mkdirSync(prefetch);
  fs.writeFileSync(path.join(sandbox, "a.txt"), "sandbox");
  fs.writeFileSync(path.join(config, "b.txt"), "config");
  fs.writeFileSync(path.join(prefetch, "c.txt"), "prefetch");

  assert.equal(resolveReadablePath(sandbox, config, prefetch, "a.txt").kind, "sandbox");
  assert.equal(resolveReadablePath(sandbox, config, prefetch, "/sandbox/a.txt").kind, "sandbox");
  assert.equal(resolveReadablePath(sandbox, config, prefetch, "/config/b.txt").kind, "config");
  assert.equal(
    resolveReadablePath(sandbox, config, prefetch, path.join(prefetch, "c.txt")).kind,
    "prefetch",
  );
  assert.throws(() => resolveReadablePath(sandbox, config, prefetch, "../outside.txt"));
});

test("list_dir and read_file work for config and prefetch roots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-paths-"));
  const sandbox = path.join(tmp, "sandbox");
  const configRoot = path.join(tmp, "config");
  const prefetchRoot = path.join(tmp, "prefetch");
  fs.mkdirSync(sandbox);
  fs.mkdirSync(path.join(configRoot, "skills"), { recursive: true });
  fs.mkdirSync(path.join(prefetchRoot, "manual"), { recursive: true });
  fs.writeFileSync(path.join(configRoot, "skills", "SKILL.md"), "# skill\n");
  fs.writeFileSync(path.join(prefetchRoot, "manual", "notes.txt"), "si here\n");
  fs.writeFileSync(path.join(prefetchRoot, "manual", "si.pdf"), "%PDF-fake");

  const listed = listReadableDir(
    sandbox,
    configRoot,
    prefetchRoot,
    path.join(prefetchRoot, "manual"),
  );
  assert.match(listed, /notes\.txt/);
  assert.match(listed, /si\.pdf/);

  assert.equal(
    readReadableFile(sandbox, configRoot, prefetchRoot, "/config/skills/SKILL.md"),
    "# skill\n",
  );
  assert.match(
    readReadableFile(
      sandbox,
      configRoot,
      prefetchRoot,
      path.join(prefetchRoot, "manual", "si.pdf"),
    ),
    /binary prefetch file/,
  );
  assert.equal(
    readReadableFile(
      sandbox,
      configRoot,
      prefetchRoot,
      path.join(prefetchRoot, "manual", "notes.txt"),
    ),
    "si here\n",
  );
});

test("resolveReadablePath rejects /config when configDir missing and /config absent", () => {
  if (fs.existsSync("/config")) {
    // Image/container has baked skills — fallback would succeed; skip.
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-paths-"));
  const sandbox = path.join(tmp, "sandbox");
  fs.mkdirSync(sandbox);
  assert.throws(
    () => resolveReadablePath(sandbox, null, "/prefetch", "/config/skills/x"),
    /config path not available/,
  );
});
