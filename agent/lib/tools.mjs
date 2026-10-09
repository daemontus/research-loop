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

import { normalizeSandboxPath } from "./sandbox-path.mjs";
import { listReadableDir, readReadableFile, resolveReadablePath } from "./workspace-paths.mjs";

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
  const raw = path.isAbsolute(p) ? String(p) : normalizeSandboxPath(p);
  const abs = path.isAbsolute(raw) ? raw : path.join(sandbox, raw);
  const rel = path.relative(sandbox, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return abs;
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
        const combine = [out, errOut].filter(Boolean).join("\n").slice(0, MAX_TOOL_OUTPUT);
        if (!err) {
          resolve(combine || "(no output)");
          return;
        }
        const timedOut =
          err.killed || err.signal === "SIGTERM" || /ETIMEDOUT/i.test(err.message);
        const header = timedOut
          ? `command timed out after ${limit}ms: ${err.message}`
          : `command failed: ${err.message}`;
        resolve(
          [header, combine].filter(Boolean).join("\n").slice(0, MAX_TOOL_OUTPUT) || header,
        );
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

function editFile(sandbox, p, oldString, newString, replaceAll) {
  const abs = resolveInSandbox(sandbox, p);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  const content = fs.readFileSync(abs, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`oldString not found in ${p}`);
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString appears ${occurrences} times in ${p}; provide more context or set replaceAll`,
    );
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  fs.writeFileSync(abs, updated);
  return `edited ${p} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
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
      description: `Read a text file. ${readRoots}`,
      parameters: Type.Object({
        path: Type.String({ description: "Path to read." }),
      }),
      execute: async (_id, params) => ({
        content: [
          {
            type: "text",
            text: readReadableFile(
              sandbox,
              configDir,
              prefetchPath,
              params.path,
              MAX_TOOL_OUTPUT,
              extraRoots,
            ),
          },
        ],
        details: {},
      }),
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
        "Replace an exact string in a sandbox file. Use for surgical edits (e.g. updating " +
        "GOALS.md status markers) instead of rewriting the whole file.",
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
