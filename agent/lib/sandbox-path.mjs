/**
 * Normalize agent-supplied paths relative to the sandbox root.
 */

import fs from "node:fs";
import path from "node:path";

export function normalizeSandboxPath(p) {
  let raw = String(p ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";

  // Agents sometimes prefix paths with "sandbox/" even though cwd is already the sandbox.
  raw = raw.replace(/^\/?sandbox\/+/i, "");

  // Drop leading slashes on relative paths so join(sandbox, p) behaves consistently.
  if (!path.isAbsolute(raw)) {
    raw = raw.replace(/^\/+/, "") || ".";
  }
  return raw;
}

/** Resolve the writable sandbox directory inside the sidecar container. */
export function resolveSandboxDir(jobSandbox) {
  const requested = String(jobSandbox ?? "").trim() || "/sandbox";
  if (requested === "/sandbox" || requested === "/sandbox/") {
    for (const mounted of ["/agent-run/sandbox", "/run/sandbox"]) {
      if (fs.existsSync(mounted)) {
        return mounted;
      }
    }
  }
  return path.resolve(requested);
}
