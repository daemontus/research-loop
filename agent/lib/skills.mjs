/**
 * Skill index loader.
 *
 * A skill is a directory under `<configDir>/skills/<name>/SKILL.md` with YAML
 * frontmatter (name, description). Adapted from pi-retrieve's retrieve.mjs.
 */
import fs from "node:fs";
import path from "node:path";

export function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: "", description: "" };
  }
  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(?:>-?\s*\n)?([\s\S]*?)(?=^\w|\s*$)/m);
  let description = descMatch ? descMatch[1].trim() : "";
  description = description
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s+/, ""))
    .filter(Boolean)
    .join(" ");
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    description,
  };
}

export function loadSkillIndex(configDir) {
  if (!configDir || !fs.existsSync(configDir)) {
    return { toolsMd: "", skillEntries: [], skillsReadme: "" };
  }

  let toolsMd = "";
  const toolsPath = path.join(configDir, "TOOLS.md");
  if (fs.existsSync(toolsPath)) {
    toolsMd = fs.readFileSync(toolsPath, "utf8");
  }

  let skillsReadme = "";
  const readmePath = path.join(configDir, "skills", "README.md");
  if (fs.existsSync(readmePath)) {
    skillsReadme = fs.readFileSync(readmePath, "utf8");
  }

  const skillEntries = [];
  const skillsRoot = path.join(configDir, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, "utf8");
      const { name, description } = parseSkillFrontmatter(content);
      skillEntries.push({
        name: name || entry.name,
        description,
        configPath: `/config/skills/${entry.name}/SKILL.md`,
      });
    }
    skillEntries.sort((a, b) => a.configPath.localeCompare(b.configPath));
  }

  return { toolsMd, skillEntries, skillsReadme };
}

/** Render the skills section used in system prompts. */
export function renderSkillsSection({ skillsReadme, skillEntries }) {
  const lines = [];
  if (skillsReadme) {
    lines.push(
      "Skill index (decision tree + tables) — read_file individual SKILL.md files as needed:",
      skillsReadme,
    );
  }
  if (!skillsReadme && skillEntries.length > 0) {
    lines.push("", "Available skills (name, when to use, path):");
    for (const entry of skillEntries) {
      const desc = entry.description ? `: ${entry.description}` : "";
      lines.push(`  - ${entry.name}${desc} → ${entry.configPath}`);
    }
  }
  if (!skillsReadme && skillEntries.length === 0) {
    lines.push("No skills configured; use paths under /config/skills/ if present.");
  }
  return lines.join("\n");
}

/**
 * Scan one or more skill roots for installed skills (session-installed skills
 * live under `<sandbox>/skills/<name>/SKILL.md`).
 *
 * @param {Array<{ dir: string, prefix: string }>} roots
 * @returns {Array<{ name: string, description: string, path: string }>}
 */
export function scanSkills(roots) {
  const entries = [];
  const seen = new Set();
  for (const root of roots || []) {
    if (!root?.dir || !fs.existsSync(root.dir)) continue;
    let names;
    try {
      names = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      let parsed = { name: "", description: "" };
      try {
        parsed = parseSkillFrontmatter(fs.readFileSync(skillFile, "utf8"));
      } catch {
        // ignore unreadable
      }
      const key = `${parsed.name || entry.name}@${root.prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        name: parsed.name || entry.name,
        description: parsed.description,
        path: `${root.prefix.replace(/\/$/, "")}/${entry.name}/SKILL.md`,
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** Render the installed-skills index injected into handoff prompts. */
export function renderInstalledSkills(entries) {
  if (!entries || entries.length === 0) return "";
  return [
    "Installed skills available in the sandbox — read the SKILL.md before doing related work,",
    "and follow it. Using a relevant installed skill is MANDATORY:",
    ...entries.map((e) => `  - ${e.name}${e.description ? `: ${e.description}` : ""} → ${e.path}`),
  ].join("\n");
}
