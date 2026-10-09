---
name: skills-discovery
description: How to find, evaluate, and install reusable Agent Skills from skills.sh for the current task.
---

# Skills discovery (skills.sh)

Use this during the **skills phase**, before planning, to decide which reusable
Agent Skills this session should install.

## Search

- Search the catalog from the shell:
  - `npx skills find <keywords>` — keyword/interactive search.
  - `npx skills add <owner/repo> --list` — list the skills inside a source.
- Browse <https://skills.sh> for the leaderboard, topics (`/topic/...`) and the
  official/curated set (`/official`).
- Prefer well-established, popular skills and skills from the technology's own
  maintainers (the curated/official set).

## Evaluate

- Read the skill's `SKILL.md` (name + description + instructions) before proposing it.
- Prefer skills whose scope matches the task. Do **not** propose skills that are
  only tangentially related.
- Check safety: skills.sh shows security audits
  (`https://skills.sh/<owner>/<repo>/<skill>/security/<provider>`) and risk levels.
  Avoid skills with `fail`/`high`/`critical` findings. Skills are third-party code —
  review before relying on them.
- Pick a small, high-signal set (typically 0-4). Fewer, sharper skills beat many.

## Propose

Call `propose_skills` with, for each candidate: `name`, `source` (`owner/repo` or a
full URL), optional `url`, `why` it is relevant, and `intendedUse`. If nothing is
genuinely relevant, use `noneNeeded: true` and justify it.

## Install (only after the advisor approves)

Use the `install_skill` harness tool (it wraps the `skills` CLI and installs into
`/sandbox/skills/<name>/`):

- `install_skill({ source: "owner/repo", skill: "skill-name" })`
- or `install_skill({ source: "owner/repo" })` to take all discovered skills.

Then `read_file` each installed `/sandbox/skills/<name>/SKILL.md`, and call
`confirm_skills_installed` with the installed list. The advisor reads the same
files at `/researcher-sandbox/skills/...`.

## Use

Installed skills are listed in every subsequent prompt. When a skill is relevant
to the current goal, read its `SKILL.md` and follow it, list it in the plan's
`skillsToUse`, and report it in the result's `skillsUsed`. Using a relevant
installed skill is mandatory.
