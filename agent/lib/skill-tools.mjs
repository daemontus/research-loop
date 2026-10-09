/**
 * Harness tool: install Agent Skills into the sandbox.
 *
 * Wraps the `skills` CLI (skills.sh) so installation is deterministic and lands
 * in `<sandbox>/skills/<slug>/` (the location the harness scans and the advisor
 * can read read-only). The CLI fetches from GitHub/git/well-known/download URLs.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { parseSkillFrontmatter } from "./skills.mjs";

const MAX_TOOL_OUTPUT = 40000;
const INSTALL_TIMEOUT_MS = 600000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || "");
        err.stderr = String(stderr || "");
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy a directory using the shell. Node's `fs.cpSync` fails with EACCES on
 * some bind mounts (e.g. Docker Desktop's virtiofs), while `cp -a` works.
 */
async function copyDir(src, dest) {
  await run("bash", ["-lc", `rm -rf -- ${shellQuote(dest)} && cp -a -- ${shellQuote(src)} ${shellQuote(dest)}`], {
    timeout: 120000,
  });
}

async function removeDir(dir) {
  try {
    await run("bash", ["-lc", `rm -rf -- ${shellQuote(dir)}`], { timeout: 60000 });
  } catch {
    // best effort
  }
}

function walkForSkillDirs(dir, acc = [], depth = 0) {
  if (depth > 6) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(abs, "SKILL.md"))) acc.push(abs);
    else walkForSkillDirs(abs, acc, depth + 1);
  }
  return acc;
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/**
 * @param {string} sandbox writable sandbox root
 * @returns {object} an AgentTool definition
 */
export function makeInstallSkillTool(sandbox) {
  const destRoot = path.join(sandbox, "skills");
  return {
    name: "install_skill",
    label: "Install Skill",
    description:
      "Install one or more Agent Skills from skills.sh / a git source / a direct download " +
      "URL into /sandbox/skills/<name>/. Pass the source exactly as skills.sh shows it " +
      "(e.g. owner/repo, plus optional skill names). After installing, read the SKILL.md " +
      "files and call confirm_skills_installed. Requires network access.",
    parameters: Type.Object({
      source: Type.String({
        description:
          "skills.sh source: 'owner/repo', a full git URL, or a direct SKILL.md/archive download URL.",
      }),
      skill: Type.Optional(
        Type.String({
          description:
            "Specific skill name(s) within the source, comma-separated; omit to install all discovered.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Override destination folder name (only when installing a single skill).",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const source = String(params?.source || "").trim();
      if (!source) throw new Error("install_skill requires a non-empty source");
      fs.mkdirSync(destRoot, { recursive: true });

      const tmp = fs.mkdtempSync(path.join(sandbox, ".skills-install-"));
      try {
        const args = ["--yes", "skills", "add", source, "--copy", "-y", "-a", "universal"];
        const skillsList = String(params?.skill || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const s of skillsList) args.push("--skill", s);

        let stdout = "";
        let stderr = "";
        try {
          const res = await run(process.platform === "win32" ? "npx.cmd" : "npx", args, {
            cwd: tmp,
            timeout: INSTALL_TIMEOUT_MS,
            env: { ...process.env, DISABLE_TELEMETRY: "1" },
          });
          stdout = res.stdout;
          stderr = res.stderr;
        } catch (e) {
          stdout = e.stdout || "";
          stderr = e.stderr || e.message || String(e);
        }

        const folders = walkForSkillDirs(tmp);
        if (folders.length === 0) {
          throw new Error(
            `install_skill: no SKILL.md found after installing '${source}'. ` +
              `npx output:\n${(stderr || stdout).slice(0, 2000)}`,
          );
        }

        const installed = [];
        for (const folder of folders) {
          const base =
            params?.name && folders.length === 1 ? params.name : path.basename(folder);
          const slug = slugify(base);
          const dest = path.join(destRoot, slug);
          await copyDir(folder, dest);
          let parsed = { name: "", description: "" };
          try {
            parsed = parseSkillFrontmatter(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"));
          } catch {
            // ignore
          }
          installed.push({
            name: parsed.name || slug,
            slug,
            description: parsed.description,
            path: `/sandbox/skills/${slug}/`,
          });
        }

        const text = [
          `Installed ${installed.length} skill(s) into /sandbox/skills/:`,
          ...installed.map(
            (s) => `  - ${s.name}${s.description ? `: ${s.description}` : ""} → ${s.path}`,
          ),
          "",
          "Next: read the SKILL.md file(s) you will use, then call confirm_skills_installed",
          "with the installed list.",
        ]
          .join("\n")
          .slice(0, MAX_TOOL_OUTPUT);
        return { content: [{ type: "text", text }], details: { installed } };
      } finally {
        await removeDir(tmp);
      }
    },
  };
}
