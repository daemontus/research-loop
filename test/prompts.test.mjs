import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildSystemPrompt } from "../agent/lib/prompts.mjs";
import { loadSkillIndex } from "../agent/lib/skills.mjs";

const BASE = { configDir: null, supportsImage: true, task: "Do research." };

describe("system prompts", () => {
  it("main researcher coordinates and never implements", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "researcher", kind: "main" });
    assert.match(prompt, /RESEARCHER of the MAIN session/);
    assert.match(prompt, /## The task\nDo research\./);
    assert.match(prompt, /review the advisor's plan/);
    assert.match(prompt, /You never implement anything yourself/);
    assert.match(prompt, /read-only file tools/);
    assert.match(prompt, /there is no goals file/);
    assert.match(prompt, /`advisory` items are non-blocking/);
  });

  it("main advisor owns the plan and approves delegations with a focus on scope", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "advisor", kind: "main" });
    assert.match(prompt, /Write the plan/);
    assert.match(prompt, /focusing on scope/);
    assert.match(prompt, /plan changes/);
    assert.match(prompt, /VERIFY[\s\S]*CRITIQUE[\s\S]*EXPLORE/);
  });

  it("orchestrator researcher cannot change its subgoals", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "researcher", kind: "orchestrator", sessionId: "S2", brief: "## Your goal\nG2" });
    assert.match(prompt, /ORCHESTRATOR session \(session S2\)/);
    assert.match(prompt, /Overall task \(context only/);
    assert.match(prompt, /## Your goal\nG2/);
    assert.match(prompt, /You cannot change your subgoals/);
  });

  it("leaf researcher implements, reports and may request an abort", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "researcher", kind: "leaf", sessionId: "S3", brief: "## Your goal\nG2.1" });
    assert.match(prompt, /Implement your goal/);
    assert.match(prompt, /`report` for the parent/);
    assert.match(prompt, /`notes` for later agents/);
    assert.match(prompt, /request_abort/);
    assert.match(prompt, /prefer the dedicated tools over bash/);
  });

  it("leaf advisor treats acceptance criteria as a floor", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "advisor", kind: "leaf", sessionId: "S3" });
    assert.match(prompt, /Acceptance criteria are\s+the floor, not the definition of done/);
    assert.match(prompt, /tests pass but the feature does not work/);
  });

  it("skills session has no goal tools section", () => {
    const prompt = buildSystemPrompt({ ...BASE, role: "researcher", kind: "skills" });
    assert.match(prompt, /npx skills find/);
    assert.doesNotMatch(prompt, /## Goals/);
  });

  it("lists installed skills", () => {
    const prompt = buildSystemPrompt({
      ...BASE,
      role: "researcher",
      kind: "leaf",
      installedSkills: [{ name: "tdd", description: "test first", path: "/sandbox/skills/tdd/SKILL.md" }],
    });
    assert.match(prompt, /tdd: test first → \/sandbox\/skills\/tdd\/SKILL\.md/);
  });

  it("advisor config ships the always-on skill packs and a decision-tree index", () => {
    const { skillsReadme, skillEntries } = loadSkillIndex(path.resolve("config", "advisor"));
    assert.ok(skillsReadme, "config/advisor/skills/README.md should be injected");
    for (const pack of ["advisor-grilling", "advisor-brainstorming", "advisor-caveman-review", "advisor-research-rigor"]) {
      assert.match(skillsReadme, new RegExp(pack));
    }
    const names = skillEntries.map((e) => e.name);
    for (const expected of ["advisor-brainstorming", "advisor-grilling", "advisor-caveman-review", "advisor-research-rigor", "reviewing-skills"]) {
      assert.ok(names.includes(expected), `expected pack ${expected} to be indexed`);
    }
  });
});
