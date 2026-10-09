import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTools } from "../agent/lib/tools.mjs";

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-image-"));
  const sandbox = path.join(tmp, "advisor-sandbox");
  const configDir = path.join(tmp, "config");
  const researcherSandbox = path.join(tmp, "researcher-sandbox");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(path.join(configDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(researcherSandbox, "plots"), { recursive: true });

  const png = Buffer.from("fake-png-bytes");
  fs.writeFileSync(path.join(sandbox, "own.png"), png);
  fs.writeFileSync(path.join(configDir, "assets", "cfg.png"), png);
  fs.writeFileSync(path.join(researcherSandbox, "plots", "x.png"), png);
  fs.writeFileSync(path.join(sandbox, "notes.txt"), "hello");

  const tools = makeTools(sandbox, {
    configDir,
    prefetchPath: path.join(tmp, "prefetch"),
    extraRoots: [{ prefix: "/researcher-sandbox", dir: researcherSandbox }],
    supportsImage: true,
  });
  const readImage = tools.find((t) => t.name === "read_image");
  return { readImage, sandbox, configDir, researcherSandbox, png };
}

test("read_image reads from the local sandbox", async () => {
  const { readImage, png } = setup();
  const res = await readImage.execute("1", { path: "own.png" });
  assert.equal(res.content[1].mimeType, "image/png");
  assert.equal(res.content[1].data, png.toString("base64"));
});

test("read_image reads from the read-only /config root", async () => {
  const { readImage } = setup();
  const res = await readImage.execute("1", { path: "/config/assets/cfg.png" });
  assert.equal(res.content[1].mimeType, "image/png");
});

test("read_image reads from an extra read-only root (advisor /researcher-sandbox)", async () => {
  const { readImage, png } = setup();
  const p = "/researcher-sandbox/plots/x.png";
  const res = await readImage.execute("1", { path: p });
  assert.match(res.content[0].text, /Image \/researcher-sandbox\/plots\/x\.png/);
  assert.equal(res.content[1].mimeType, "image/png");
  assert.equal(res.content[1].data, png.toString("base64"));
});

test("read_image rejects paths outside every readable root", async () => {
  const { readImage } = setup();
  await assert.rejects(
    () => readImage.execute("1", { path: "/etc/hosts" }),
    /path escapes sandbox/,
  );
  await assert.rejects(
    () => readImage.execute("1", { path: "../../etc/hosts" }),
    /path escapes sandbox/,
  );
});

test("read_image rejects non-image and missing files", async () => {
  const { readImage } = setup();
  await assert.rejects(
    () => readImage.execute("1", { path: "notes.txt" }),
    /unsupported image type/,
  );
  await assert.rejects(
    () => readImage.execute("1", { path: "missing.png" }),
    /no such file/,
  );
});
