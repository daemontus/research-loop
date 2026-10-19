/**
 * `grep` tool backend: search file contents and return `path:line:text`
 * matches, so an agent can find a spot and then read just that range.
 *
 * Uses ripgrep when installed (it is in the agent image); otherwise a small
 * built-in walker so local (non-docker) runs still work.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_GREP_RESULTS = 100;
export const MAX_GREP_RESULTS = 500;
const MAX_MATCH_CHARS = 300;
const GREP_TIMEOUT_MS = 30000;
// Built-in fallback only (ripgrep applies .gitignore and skips hidden files).
const SKIP_DIRS = new Set([".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".cache"]);
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FALLBACK_FILES = 20000;

let rgAvailable = null;
function hasRipgrep() {
  if (rgAvailable === null) {
    rgAvailable = (process.env.PATH || "")
      .split(path.delimiter)
      .some((dir) => dir && fs.existsSync(path.join(dir, "rg")));
  }
  return rgAvailable;
}

function clip(text) {
  return text.length > MAX_MATCH_CHARS ? `${text.slice(0, MAX_MATCH_CHARS)}…` : text;
}

/**
 * @param {string} abs resolved file or directory to search
 * @param {string} display how the agent wrote that path (used in the output)
 * @param {object} opts
 * @param {string} opts.pattern regular expression (or literal with fixedStrings)
 * @param {string} [opts.glob] only search files matching this glob (e.g. "*.rs")
 * @param {boolean} [opts.ignoreCase]
 * @param {boolean} [opts.fixedStrings] treat the pattern as a literal string
 * @param {number} [opts.maxResults]
 * @param {boolean} [opts.forceFallback] tests: skip ripgrep
 * @returns {Promise<string>}
 */
export async function grepFiles(abs, display, opts) {
  if (!opts?.pattern) throw new Error("pattern is required");
  if (!fs.existsSync(abs)) throw new Error(`no such file or directory: ${display}`);
  const max = Math.min(
    MAX_GREP_RESULTS,
    Math.max(1, Math.floor(Number(opts.maxResults) || DEFAULT_GREP_RESULTS)),
  );
  const { matches, more } =
    hasRipgrep() && !opts.forceFallback
      ? await ripgrep(abs, opts, max)
      : fallbackGrep(abs, opts, max);
  if (!matches.length) return `no matches for ${JSON.stringify(opts.pattern)} in ${display}`;
  const base = display.replace(/\/+$/, "") || ".";
  const isDir = fs.statSync(abs).isDirectory();
  const lines = matches.map(({ file, line, text }) => {
    const shown = isDir ? `${base}/${path.relative(abs, file).split(path.sep).join("/")}` : display;
    return `${shown}:${line}:${clip(text)}`;
  });
  if (more) {
    lines.push(`[showing the first ${max} matches; narrow the pattern, path or glob, or raise maxResults]`);
  }
  return lines.join("\n");
}

/** Collect up to `max` matches from ripgrep's JSON output, then stop it. */
function ripgrep(abs, opts, max) {
  const args = ["--json", "--no-config"];
  if (opts.ignoreCase) args.push("--ignore-case");
  if (opts.fixedStrings) args.push("--fixed-strings");
  if (opts.glob) args.push("--glob", opts.glob);
  args.push("--regexp", opts.pattern, "--", abs);
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const matches = [];
    let more = false;
    let buf = "";
    let stderr = "";
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ matches, more });
    };
    const timer = setTimeout(() => {
      child.kill();
      more = true;
      finish(null);
    }, GREP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        if (ev.type !== "match") continue;
        if (matches.length >= max) {
          more = true;
          child.kill();
          finish(null);
          return;
        }
        matches.push({
          file: ev.data.path?.text ?? "",
          line: ev.data.line_number,
          text: String(ev.data.lines?.text ?? "").replace(/\r?\n$/, ""),
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      // 0 = matches, 1 = none; 2 = error (but partial results may be usable).
      if (code === 2 && !matches.length) {
        finish(new Error(`grep failed: ${stderr.trim().split("\n")[0] || "invalid pattern or path"}`));
      } else {
        finish(null);
      }
    });
  });
}

function fallbackGrep(abs, opts, max) {
  let re;
  try {
    const source = opts.fixedStrings ? opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : opts.pattern;
    re = new RegExp(source, opts.ignoreCase ? "i" : "");
  } catch (e) {
    throw new Error(`invalid pattern: ${e.message}`);
  }
  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  const matches = [];
  let scanned = 0;
  const visit = (file) => {
    if (matches.length > max || scanned >= MAX_FALLBACK_FILES) return;
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (file !== abs && SKIP_DIRS.has(path.basename(file))) return;
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (!st.isFile() || st.size > MAX_FALLBACK_FILE_BYTES) return;
    if (globRe && !globRe.test(path.basename(file))) return;
    scanned += 1;
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && matches.length <= max; i += 1) {
      if (re.test(lines[i])) matches.push({ file, line: i + 1, text: lines[i].replace(/\r$/, "") });
    }
  };
  visit(abs);
  const more = matches.length > max;
  return { matches: matches.slice(0, max), more };
}

/** Basename glob (`*.rs`, `test_?.py`, `*.{js,mjs}`) to a RegExp. */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
