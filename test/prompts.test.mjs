import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildAdvisorPrompt, buildResearcherPrompt } from "../agent/lib/prompts.mjs";
import { loadSkillIndex } from "../agent/lib/skills.mjs";

const BASE = { sandbox: "/sandbox", configDir: null, supportsImage: true, task: "Do research." };

describe("role prompts", () => {
  it("researcher prompt includes the skills phase by default", () => {
    const prompt = buildResearcherPrompt({ ...BASE });
    assert.match(prompt, /Phase 0 — skills discovery/);
    assert.match(prompt, /propose_skills/);
    assert.match(prompt, /Do NOT submit a task plan until the skills step is complete/);
  });

  it("researcher prompt skips the skills phase when skipSkills is set", () => {
    const prompt = buildResearcherPrompt({ ...BASE, skipSkills: true });
    assert.doesNotMatch(prompt, /Phase 0 — skills discovery/);
    assert.doesNotMatch(prompt, /do this before anything else/);
    // The skills control tools are no longer listed (only named to say "do NOT
    // call them").
    assert.doesNotMatch(prompt, /\n  - propose_skills/);
    assert.doesNotMatch(prompt, /\n  - confirm_skills_installed/);
    assert.match(prompt, /skills-discovery phase is skipped/);
    assert.match(prompt, /decomposing the task into goals/);
  });

  it("researcher prompt still mandates using pre-installed skills with skipSkills", () => {
    const prompt = buildResearcherPrompt({ ...BASE, skipSkills: true });
    assert.match(prompt, /Skills are mandatory when relevant/);
    assert.match(prompt, /MUST still use them where\s+relevant/);
  });

  it("advisor prompt is unaffected by skipSkills", () => {
    const prompt = buildAdvisorPrompt({ ...BASE });
    assert.match(prompt, /approve_skills/);
    assert.match(prompt, /request_skill_changes/);
  });

  it("advisor prompt carries the always-on doctrine and exploratory self-check", () => {
    const prompt = buildAdvisorPrompt({ ...BASE });
    assert.match(prompt, /Advisor doctrine/);
    assert.match(prompt, /VERIFY \(gating\)/);
    assert.match(prompt, /CRITIQUE \(red-team\)/);
    assert.match(prompt, /EXPLORE \(value-add\)/);
    assert.match(prompt, /Is there value we can add beyond what is explicitly in the task\?/);
    assert.match(prompt, /Is there a plausible failure or stronger alternative/);
    assert.match(prompt, /`advisory` items are fire-and-forget recommendations/);
    assert.match(prompt, /advisor-grilling/);
  });

  it("researcher prompt asks it to respond to advisory recommendations", () => {
    const prompt = buildResearcherPrompt({ ...BASE });
    assert.match(prompt, /Respond to advisor recommendations/);
    assert.match(prompt, /`advisory` recommendations/);
    assert.match(prompt, /briefly justify declining/);
  });

  it("advisor config ships the always-on skill packs and a decision-tree index", () => {
    const { skillsReadme, skillEntries } = loadSkillIndex(
      path.resolve("config", "advisor"),
    );
    assert.ok(skillsReadme, "config/advisor/skills/README.md should be injected");
    assert.match(skillsReadme, /advisor-grilling/);
    assert.match(skillsReadme, /advisor-brainstorming/);
    assert.match(skillsReadme, /advisor-caveman-review/);
    assert.match(skillsReadme, /advisor-research-rigor/);
    const names = skillEntries.map((e) => e.name);
    for (const expected of [
      "advisor-brainstorming",
      "advisor-grilling",
      "advisor-caveman-review",
      "advisor-research-rigor",
      "reviewing-skills",
    ]) {
      assert.ok(names.includes(expected), `expected pack ${expected} to be indexed`);
    }
  });
});