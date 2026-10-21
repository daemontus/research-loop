---
name: skills-discovery
description: How to find, evaluate, and install reusable Agent Skills from skills.sh for the current task.
---

# Skills discovery (skills.sh)

Use this in the **skills session** (the first step of a run, before planning)
to decide which reusable Agent Skills the run should install.

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
full URL, exactly as skills.sh shows it), the `skill` name within the source when it
holds several, and `why` it is relevant. If nothing is genuinely relevant, use
`noneNeeded: true` and justify it.

## Install

You do not install anything. Once the advisor approves, the harness installs the
approved skills into `/sandbox/skills/<name>/` for both agents (it runs the
`skills` CLI itself) and starts the main session.

## Use

Installed skills are listed in every later system prompt, and each goal names the
skills relevant to it. Before work a skill applies to, read its `SKILL.md` and
follow it.
