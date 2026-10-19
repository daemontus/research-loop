/**
 * Sandbox tools available to both agents.
 *
 * Writes are confined to the agent's own sandbox. Reads may also target
 * read-only roots (/config, /prefetch, and any `extraRoots` such as the
 * advisor's /researcher-sandbox).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { DEFAULT_GREP_RESULTS, MAX_GREP_RESULTS, grepFiles } from "./grep.mjs";
import { normalizeSandboxPath } from "./sandbox-path.mjs";
import {
  DEFAULT_READ_LINES,
  listReadableDir,
  readReadableLines,
  resolveReadablePath,
} from "./workspace-paths.mjs";

export const MAX_TOOL_OUTPUT = 40000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function resolveInSandbox(sandbox, p) {
  const str = String(p);
  // Map the in-container "/sandbox" prefix onto the real sandbox dir (as reads do).
  const raw =
    str === "/sandbox" || str === "/sandbox/"
      ? "."
      : path.isAbsolute(str) && !str.startsWith("/sandbox/")
        ? str
        : normalizeSandboxPath(str);
  const abs = path.isAbsolute(raw) ? raw : path.join(sandbox, raw);
  const rel = path.relative(sandbox, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return abs;
}

/**
 * Shorten long output by cutting the middle: the start shows what ran, the
 * end is where errors and summaries usually are.
 */
export function truncateMiddle(text, max = MAX_TOOL_OUTPUT) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${s.slice(s.length - tail)}`;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function runBash(sandbox, command, timeoutMs) {
  const limit = timeoutMs || 120000;
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      { cwd: sandbox, timeout: limit, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        const errOut = String(stderr || "");
        const combine = truncateMiddle([out, errOut].filter(Boolean).join("\n"));
        if (!err) {
          resolve(combine || "(no output)");
          return;
        }
        const timedOut =
          err.killed || err.signal === "SIGTERM" || /ETIMEDOUT/i.test(err.message);
        const header = timedOut
          ? `command timed out after ${limit}ms: ${err.message}`
          : `command failed: ${err.message}`;
        resolve(truncateMiddle([header, combine].filter(Boolean).join("\n")) || header);
      },
    );
  });
}

function writeFile(sandbox, p, content) {
  const abs = resolveInSandbox(sandbox, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ""));
  return `wrote ${p} (${fs.statSync(abs).size} bytes)`;
}

/** 1-based line numbers at which each occurrence of `needle` starts. */
function occurrenceLines(content, needle) {
  const lines = [];
  let line = 1;
  let scanned = 0;
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + needle.length)) {
    for (let j = scanned; j < i; j += 1) if (content.charCodeAt(j) === 10) line += 1;
    scanned = i;
    lines.push(line);
  }
  return lines;
}

function lineList(lines, max = 10) {
  const shown = lines.slice(0, max).join(", ");
  return lines.length > max ? `${shown}, ... (${lines.length} in total)` : shown;
}

/**
 * Why `oldString` did not match, with where to look: a match that differs
 * only in whitespace/indentation, else the lines containing its first line.
 */
function explainNoMatch(content, oldString, p) {
  const norm = (s) => s.trim().replace(/\s+/g, " ");
  const fileLines = content.split("\n").map(norm);
  const want = oldString.split("\n").map(norm);
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  const hint = `Re-read that part with read_file (offset/limit) and copy the text exactly, without the line-number prefix.`;
  if (!want.length) return `oldString not found in ${p} (it is only whitespace)`;
  const fuzzy = [];
  for (let i = 0; i + want.length <= fileLines.length; i += 1) {
    if (want.every((w, k) => fileLines[i + k] === w)) fuzzy.push(i + 1);
  }
  if (fuzzy.length) {
    const span = (s) => (want.length > 1 ? `${s}-${s + want.length - 1}` : String(s));
    return (
      `oldString not found exactly in ${p}, but it matches line${want.length > 1 ? "s" : ""} ` +
      `${fuzzy.slice(0, 5).map(span).join(", ")} if whitespace/indentation is ignored. ${hint}`
    );
  }
  const first = fileLines
    .map((l, i) => (l && l.includes(want[0]) ? i + 1 : 0))
    .filter(Boolean);
  if (first.length) {
    return (
      `oldString not found in ${p}. Its first line (${JSON.stringify(want[0].slice(0, 80))}) ` +
      `appears at line${first.length > 1 ? "s" : ""} ${lineList(first)}; a later line differs. ${hint}`
    );
  }
  return `oldString not found in ${p}, and its first line appears nowhere in the file. ${hint}`;
}

function editFile(sandbox, p, oldString, newString, replaceAll) {
  const abs = resolveInSandbox(sandbox, p);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  if (!oldString) throw new Error("oldString must not be empty (use write_file to create a file)");
  const content = fs.readFileSync(abs, "utf8");
  const at = occurrenceLines(content, oldString);
  if (at.length === 0) throw new Error(explainNoMatch(content, oldString, p));
  if (at.length > 1 && !replaceAll) {
    throw new Error(
      `oldString appears ${at.length} times in ${p} (at lines ${lineList(at)}); include more ` +
        "surrounding lines to make it unique, or set replaceAll",
    );
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, () => newString);
  fs.writeFileSync(abs, updated);
  const where = at.length === 1 ? `at line ${at[0]}` : `at lines ${lineList(at)}`;
  return `edited ${p} (${at.length} replacement${at.length === 1 ? "" : "s"} ${where})`;
}

function readImage(sandbox, configDir, prefetchPath, p, extraRoots = []) {
  const { abs } = resolveReadablePath(sandbox, configDir, prefetchPath, p, extraRoots);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${p}`);
  const ext = path.extname(abs).toLowerCase();
  const mimeType = IMAGE_MIME[ext];
  if (!mimeType) {
    throw new Error(
      `unsupported image type ${ext || "(none)"}; use .png, .jpg, .jpeg, .gif, or .webp`,
    );
  }
  const size = fs.statSync(abs).size;
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${size} bytes; max ${MAX_IMAGE_BYTES})`);
  }
  const data = fs.readFileSync(abs).toString("base64");
  return { mimeType, data, rel: String(p), size };
}

/**
 * @param {string} sandbox
 * @param {object} opts
 * @param {string|null} [opts.configDir]
 * @param {string} [opts.prefetchPath]
 * @param {Array<{prefix:string,dir:string}>} [opts.extraRoots]
 * @param {boolean} [opts.supportsImage]
 * @param {(name:string,desc:string)=>void} [opts.onTool] optional audit hook
 */
export function makeTools(sandbox, opts = {}) {
  const {
    configDir = null,
    prefetchPath = "/prefetch",
    extraRoots = [],
    supportsImage = true,
    onTool = null,
  } = opts;

  const readRoots = [
    "Reads may target the sandbox (relative paths), /config, /prefetch" +
      (extraRoots.length
        ? `, or read-only ${extraRoots.map((r) => r.prefix).join(", ")}`
        : "") +
      ".",
  ].join(" ");

  const tools = [
    {
      name: "bash",
      label: "Bash",
      description:
        "Run a shell command in the sandbox working directory. Use for installing tools, " +
        "building, running tests, git, downloading files, and inspecting output. Output is capped.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to run." }),
        timeoutMs: Type.Optional(
          Type.Number({ description: "Optional timeout in milliseconds (default 120000)." }),
        ),
      }),
      execute: async (_id, params) => ({
        content: [
          {
            type: "text",
            text: await runBash(sandbox, params.command, params.timeoutMs),
          },
        ],
        details: {},
      }),
    },
    {
      name: "list_dir",
      label: "List Directory",
      description: `List files and directories. ${readRoots} Trailing '/' marks directories.`,
      parameters: Type.Object({
        path: Type.String({
          description: "Sandbox-relative path, /config/..., /prefetch/..., or a read-only root.",
          default: ".",
        }),
      }),
      execute: async (_id, params) => ({
        content: [
          {
            type: "text",
            text: listReadableDir(sandbox, configDir, prefetchPath, params.path, extraRoots),
          },
        ],
        details: {},
      }),
    },
    {
      name: "read_file",
      label: "Read File",
      description:
        "Read a text file, or a range of its lines. Lines are numbered (`<line>\\t<text>`). " +
        `Reads up to ${DEFAULT_READ_LINES} lines from \`offset\` (default: line 1); when the ` +
        "output stops early it ends with a [lines A-B of N; continue with offset=...] note. " +
        "Use grep to find the lines you need, then read just that range. " +
        readRoots,
      parameters: Type.Object({
        path: Type.String({ description: "Path to read." }),
        offset: Type.Optional(
          Type.Number({ description: "1-based line to start reading from (default 1)." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: `Maximum number of lines to read (default ${DEFAULT_READ_LINES}).` }),
        ),
      }),
      execute: async (_id, params) => ({
        content: [
          {
            type: "text",
            text: readReadableLines(
              sandbox,
              configDir,
              prefetchPath,
              params.path,
              { offset: params.offset, limit: params.limit, maxChars: MAX_TOOL_OUTPUT },
              extraRoots,
            ),
          },
        ],
        details: {},
      }),
    },
    {
      name: "grep",
      label: "Grep",
      description:
        "Search file contents with a regular expression and list matches as `path:line:text`. " +
        "Searches a directory recursively (skipping .gitignored and hidden files) or a single " +
        "file. Use it to locate code, then read_file with offset/limit around the match. " +
        readRoots,
      parameters: Type.Object({
        pattern: Type.String({ description: "Regular expression to search for." }),
        path: Type.Optional(
          Type.String({ description: "File or directory to search (default: the sandbox)." }),
        ),
        glob: Type.Optional(
          Type.String({ description: 'Only search files matching this glob, e.g. "*.rs" or "*.{ts,tsx}".' }),
        ),
        ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
        fixedStrings: Type.Optional(
          Type.Boolean({ description: "Treat the pattern as a literal string, not a regex." }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: `Maximum matches to return (default ${DEFAULT_GREP_RESULTS}, max ${MAX_GREP_RESULTS}).`,
          }),
        ),
      }),
      execute: async (_id, params) => {
        const display = params.path || ".";
        const { abs } = resolveReadablePath(sandbox, configDir, prefetchPath, display, extraRoots);
        const text = await grepFiles(abs, display, params);
        return { content: [{ type: "text", text }], details: {} };
      },
    },
    {
      name: "write_file",
      label: "Write File",
      description:
        "Write text content to a file in the sandbox (creating parent dirs as needed). " +
        "Use this to maintain GOALS.md, source files, notes, etc.",
      parameters: Type.Object({
        path: Type.String({ description: "Path relative to the sandbox." }),
        content: Type.String({ description: "The full text content to write." }),
      }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: writeFile(sandbox, params.path, params.content) }],
        details: {},
      }),
    },
    {
      name: "edit_file",
      label: "Edit File",
      description:
        "Replace an exact string in a sandbox file. Use for surgical edits instead of " +
        "rewriting the whole file. `oldString` must match the file exactly (including " +
        "indentation) and be unique unless replaceAll is set; copy it from read_file output " +
        "without the line-number prefix. On failure the error says where the closest match is.",
      parameters: Type.Object({
        path: Type.String({ description: "Path relative to the sandbox." }),
        oldString: Type.String({ description: "Exact text to replace." }),
        newString: Type.String({ description: "Replacement text." }),
        replaceAll: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence (default false)." }),
        ),
      }),
      execute: async (_id, params) => ({
        content: [
          {
            type: "text",
            text: editFile(
              sandbox,
              params.path,
              params.oldString,
              params.newString ?? "",
              params.replaceAll,
            ),
          },
        ],
        details: {},
      }),
    },
  ];

  if (supportsImage) {
    tools.push({
      name: "read_image",
      label: "Read Image",
      description:
        "Load a PNG/JPEG/GIF/WebP image for visual inspection (diagrams, plots). " + readRoots,
      parameters: Type.Object({
        path: Type.String({
          description: "Sandbox-relative path, /config/..., /prefetch/..., or a read-only root.",
        }),
      }),
      execute: async (_id, params) => {
        const { mimeType, data, rel, size } = readImage(
          sandbox,
          configDir,
          prefetchPath,
          params.path,
          extraRoots,
        );
        return {
          content: [
            { type: "text", text: `Image ${rel} (${size} bytes, ${mimeType})` },
            { type: "image", mimeType, data },
          ],
          details: {},
        };
      },
    });
  }

  if (onTool) onTool(tools);
  return tools;
}

export { shellQuote };
