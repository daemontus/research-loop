/**
 * Fingerprint of the agent code: a hash over every source file under `agent/`
 * plus `package-lock.json` (the dependencies the image installs).
 *
 * The agent process computes it from the code it runs (baked into the Docker
 * image at /app) and sends it when it registers; the control plane computes it
 * from the checkout it runs from. A mismatch means the image was built from
 * different agent code (e.g. an old image after the protocol changed), so the
 * control plane refuses the agent instead of letting it speak a protocol the
 * harness does not. Nothing has to be bumped by hand.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXT = new Set([".mjs", ".js", ".cjs", ".json"]);

/** Root of the code this module belongs to (the folder holding agent/). */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(abs, base, out);
    else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

/**
 * @param {string} [root] folder holding `agent/` and `package-lock.json`
 * @returns {string} short hex fingerprint
 */
export function agentCodeHash(root = CODE_ROOT) {
  const hash = createHash("sha256");
  const files = sourceFiles(path.join(root, "agent")).map((f) => `agent/${f}`).sort();
  if (fs.existsSync(path.join(root, "package-lock.json"))) files.push("package-lock.json");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
