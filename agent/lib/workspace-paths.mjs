/**
 * Resolve readable paths for list_dir / read_file.
 *
 * Readable roots:
 *   - the writable sandbox (agent's own workspace)
 *   - read-only /config (skills, TOOLS.md)
 *   - read-only /prefetch when present
 *   - read-only extra roots (e.g. /researcher-sandbox for the advisor)
 *
 * Writes are always confined to the sandbox and handled separately in tools.mjs.
 */
import fs from "node:fs";
import path from "node:path";

import { normalizeSandboxPath } from "./sandbox-path.mjs";

/**
 * @param {string} sandbox
 * @param {string | null} configDir host path mounted as /config
 * @param {string | null} prefetchRoot container/host path for prefetch (default /prefetch)
 * @param {string} p
 * @param {Array<{ prefix: string, dir: string }>} [extraRoots]
 * @returns {{ abs: string, kind: string }}
 */
export function resolveReadablePath(sandbox, configDir, prefetchRoot, p, extraRoots = []) {
  const raw = String(p || ".").trim() || ".";

  if (raw === "/config" || raw.startsWith("/config/")) {
    const root = configDir || (fs.existsSync("/config") ? "/config" : null);
    if (!root) throw new Error(`config path not available: ${p}`);
    const rel = raw === "/config" ? "" : raw.slice("/config/".length);
    const abs = path.resolve(path.join(root, rel));
    if (!isInside(abs, path.resolve(root))) throw new Error(`path escapes config: ${p}`);
    return { abs, kind: "config" };
  }

  for (const extra of extraRoots) {
    const prefix = String(extra?.prefix || "").replace(/\/$/, "");
    if (!prefix) continue;
    if (raw === prefix || raw.startsWith(`${prefix}/`)) {
      const rel = raw === prefix ? "" : raw.slice(prefix.length + 1);
      const root = path.resolve(extra.dir);
      const abs = path.resolve(path.join(root, rel));
      if (!isInside(abs, root)) throw new Error(`path escapes ${prefix}: ${p}`);
      return { abs, kind: prefix.replace(/^\//, "") || "external" };
    }
  }

  if (raw === "/sandbox" || raw.startsWith("/sandbox/")) {
    const rel = raw === "/sandbox" ? "" : raw.slice("/sandbox/".length);
    const abs = path.resolve(path.join(sandbox, rel));
    const root = path.resolve(sandbox);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`path escapes sandbox: ${p}`);
    }
    return { abs, kind: "sandbox" };
  }

  const prefetchBase = String(prefetchRoot || "/prefetch").replace(/\/$/, "") || "/prefetch";
  if (raw === prefetchBase || raw.startsWith(`${prefetchBase}/`)) {
    const abs = path.resolve(raw);
    const root = path.resolve(prefetchBase);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`path escapes prefetch: ${p}`);
    }
    return { abs, kind: "prefetch" };
  }

  const normalized = path.isAbsolute(raw) ? raw : normalizeSandboxPath(raw);
  const abs = path.isAbsolute(normalized) ? normalized : path.join(sandbox, normalized);
  const rel = path.relative(sandbox, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return { abs, kind: "sandbox" };
}

function isInside(abs, root) {
  return abs === root || abs.startsWith(root + path.sep);
}

export function listReadableDir(sandbox, configDir, prefetchRoot, p, extraRoots = []) {
  const { abs } = resolveReadablePath(sandbox, configDir, prefetchRoot, p || ".", extraRoots);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${p}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`not a directory: ${p}`);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join("\n");
}

export function readReadableFile(
  sandbox,
  configDir,
  prefetchRoot,
  p,
  maxBytes,
  extraRoots = [],
) {
  const { abs, kind } = resolveReadablePath(sandbox, configDir, prefetchRoot, p, extraRoots);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${p}`);
  const size = fs.statSync(abs).size;
  if (size > 5 * 1024 * 1024) {
    return `[file too large to read; size=${size} bytes; use bash to inspect]`;
  }
  if (kind === "prefetch") {
    const ext = path.extname(abs).toLowerCase();
    if ([".pdf", ".zip", ".gz", ".tgz", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      return `[binary prefetch file (${ext}, ${size} bytes); copy to /sandbox and use pdftotext/unzip/file]`;
    }
  }
  const text = fs.readFileSync(abs, "utf8").slice(0, maxBytes ?? 200_000);
  return text || "(empty file)";
}
