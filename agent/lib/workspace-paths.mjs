/**
 * Resolve readable paths for list_dir / read_file / grep.
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

/** Files above this size are not read at all (use bash to slice them). */
const MAX_READ_BYTES = 50 * 1024 * 1024;
export const DEFAULT_READ_LINES = 2000;
/** Longer lines are shortened in read output (minified JS, CSV blobs, ...). */
export const MAX_READ_LINE_CHARS = 2000;

/**
 * Read a range of lines from a readable file, numbered like `cat -n`
 * (`<line>\t<text>`). The output never exceeds `maxChars`: it stops at a
 * line boundary and says which `offset` continues the read, so a partial
 * read is never silent.
 *
 * @param {object} [range]
 * @param {number} [range.offset] 1-based first line (default 1)
 * @param {number} [range.limit] max number of lines (default DEFAULT_READ_LINES)
 * @param {number} [range.maxChars] output budget (default 40000)
 */
export function readReadableLines(
  sandbox,
  configDir,
  prefetchRoot,
  p,
  { offset = 1, limit = DEFAULT_READ_LINES, maxChars = 40000 } = {},
  extraRoots = [],
) {
  const { abs, kind } = resolveReadablePath(sandbox, configDir, prefetchRoot, p, extraRoots);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${p}`);
  const size = fs.statSync(abs).size;
  if (size > MAX_READ_BYTES) {
    return `[file too large to read (${size} bytes); use bash (head/tail/sed -n) to inspect it]`;
  }
  if (kind === "prefetch") {
    const ext = path.extname(abs).toLowerCase();
    if ([".pdf", ".zip", ".gz", ".tgz", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      return `[binary prefetch file (${ext}, ${size} bytes); copy to /sandbox and use pdftotext/unzip/file]`;
    }
  }
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) {
    return `[binary file (${size} bytes); use bash (file, xxd, strings, ...) to inspect it]`;
  }
  const text = buf.toString("utf8");
  if (!text) return "(empty file)";
  const lines = text.split("\n");
  // A trailing newline does not start another line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;

  const start = Math.max(1, Math.floor(Number(offset) || 1));
  const count = Math.max(1, Math.floor(Number(limit) || DEFAULT_READ_LINES));
  if (start > total) {
    return `[${p} has ${total} line${total === 1 ? "" : "s"}; offset ${start} is past the end]`;
  }
  const end = Math.min(total, start + count - 1);
  const width = String(end).length;
  const out = [];
  let used = 0;
  let last = start - 1;
  for (let n = start; n <= end; n += 1) {
    let line = lines[n - 1].replace(/\r$/, "");
    if (line.length > MAX_READ_LINE_CHARS) {
      line = `${line.slice(0, MAX_READ_LINE_CHARS)}… [line truncated; ${line.length} chars]`;
    }
    const row = `${String(n).padStart(width)}\t${line}`;
    // Always show at least one line; otherwise stay within the budget.
    if (out.length && used + row.length + 1 > maxChars) break;
    out.push(row);
    used += row.length + 1;
    last = n;
  }
  if (start === 1 && last === total) return out.join("\n");
  const more = last < total ? `; continue with offset=${last + 1}` : "";
  out.push(`[lines ${start}-${last} of ${total}${more}]`);
  return out.join("\n");
}
