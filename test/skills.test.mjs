import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { installSkill, installSkills } from "../agent/lib/skill-tools.mjs";
import { parseSkillFrontmatter, renderInstalledSkills, scanSkills } from "../agent/lib/skills.mjs";

function writeSkill(root, dir, name, description) {
  const skillDir = path.join(root, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe("installed skills scanning", () => {
  it("finds skills under a root and renders an index", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-skills-"));
    const root = path.join(tmp, "skills");
    writeSkill(root, "tdd", "tdd", "Test-driven development workflow");
    writeSkill(root, "not-a-skill", "nope", "no SKILL.md"); // overwritten below to remove SKILL.md
    fs.rmSync(path.join(root, "not-a-skill", "SKILL.md"));

    const entries = scanSkills([{ dir: root, prefix: "/sandbox/skills" }]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "tdd");
    assert.match(entries[0].description, /Test-driven/);
    assert.equal(entries[0].path, "/sandbox/skills/tdd/SKILL.md");

    const rendered = renderInstalledSkills(entries);
    assert.match(rendered, /tdd/);
    assert.match(rendered, /MANDATORY/);
    assert.match(rendered, /\/sandbox\/skills\/tdd\/SKILL.md/);
  });

  it("returns an empty render when there are no skills", () => {
    assert.equal(renderInstalledSkills([]), "");
    assert.deepEqual(scanSkills([{ dir: "/does/not/exist", prefix: "/x" }]), []);
  });

  it("parses frontmatter", () => {
    const parsed = parseSkillFrontmatter("---\nname: a\ndescription: b c\n---\nbody");
    assert.deepEqual(parsed, { name: "a", description: "b c" });
  });
});

describe("harness skill installer", () => {
  it("rejects an empty source without touching the network", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-install-"));
    await assert.rejects(() => installSkill(tmp, { source: "  " }), /source is required/);
  });

  it("collects failures instead of stopping at the first one", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-install-"));
    const fake = async (_sandbox, spec) => {
      if (spec.source === "bad/repo") throw new Error("no SKILL.md found");
      return [{ name: spec.source.split("/")[1], slug: "x", description: "", path: "/sandbox/skills/x/" }];
    };
    const result = await installSkills(tmp, [{ source: "bad/repo" }, { source: "good/tdd" }], fake);
    assert.deepEqual(result.installed.map((s) => s.name), ["tdd"]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].source, "bad/repo");
    assert.match(result.errors[0].error, /no SKILL\.md/);
  });
});
