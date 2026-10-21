/**
 * Harness skill installer: installs approved Agent Skills into the sandbox.
 *
 * The agent process runs this itself when the control plane asks
 * (`install_skills`); no model is involved. Wraps the `skills` CLI (skills.sh)
 * so skills land in `<sandbox>/skills/<slug>/`, where prompts list them.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseSkillFrontmatter } from "./skills.mjs";

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
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/**
 * Install one skill source (skills.sh `owner/repo`, a git URL or a download
 * URL) into `<sandbox>/skills/<slug>/` with the `skills` CLI.
 * @param {string} sandbox writable sandbox root
 * @param {{ source: string, skill?: string|null, name?: string|null }} spec
 * @returns {Promise<Array<{ name: string, slug: string, description: string, path: string }>>}
 */
export async function installSkill(sandbox, spec) {
  const source = String(spec?.source || "").trim();
  if (!source) throw new Error("a skill source is required");
  const destRoot = path.join(sandbox, "skills");
  fs.mkdirSync(destRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(sandbox, ".skills-install-"));
  try {
    const args = ["--yes", "skills", "add", source, "--copy", "-y", "-a", "universal"];
    for (const s of String(spec?.skill || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      args.push("--skill", s);
    }
    let output = "";
    try {
      const res = await run(process.platform === "win32" ? "npx.cmd" : "npx", args, {
        cwd: tmp,
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env, DISABLE_TELEMETRY: "1" },
      });
      output = res.stderr || res.stdout;
    } catch (e) {
      output = e.stderr || e.stdout || e.message || String(e);
    }
    const folders = walkForSkillDirs(tmp);
    if (folders.length === 0) {
      throw new Error(`no SKILL.md found after installing '${source}': ${output.slice(0, 1000)}`);
    }
    const installed = [];
    for (const folder of folders) {
      const base = spec?.name && folders.length === 1 ? spec.name : path.basename(folder);
      const slug = slugify(base);
      const dest = path.join(destRoot, slug);
      await copyDir(folder, dest);
      let parsed = { name: "", description: "" };
      try {
        parsed = parseSkillFrontmatter(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"));
      } catch {
        // ignore
      }
      installed.push({ name: parsed.name || slug, slug, description: parsed.description, path: `/sandbox/skills/${slug}/` });
    }
    return installed;
  } finally {
    await removeDir(tmp);
  }
}

/**
 * Install every approved skill; failures are collected, not thrown, so one
 * bad source does not block the run.
 * @param {string} sandbox
 * @param {Array<{ source: string, skill?: string|null, name?: string }>} skills
 */
export async function installSkills(sandbox, skills, install = installSkill) {
  const installed = [];
  const errors = [];
  for (const spec of skills || []) {
    try {
      installed.push(...(await install(sandbox, spec)));
    } catch (e) {
      errors.push({ source: spec?.source || "", skill: spec?.skill || null, error: String(e?.message || e).slice(0, 2000) });
    }
  }
  return { installed, errors };
}
