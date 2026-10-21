---
name: reviewing-skills
description: How to judge a proposed skills set and verify that installed skills were actually used.
---

# Reviewing proposed skills

You do not install skills yourself; you review the researcher's proposal and then
verify they used what was approved. You can read the installed skills at
`/researcher-sandbox/skills/<name>/SKILL.md`.

## On a skills proposal

- Check each candidate is genuinely relevant to the task (not tangential).
- Prefer popular, well-maintained skills and the official/curated set.
- Consider safety. skills.sh publishes audits and risk levels; flag or reject
  anything risky (`fail`/`high`/`critical`). You may `curl` the skill page or, if
  you have network access, inspect the skill's `SKILL.md` yourself.
- Approve (`approve_skills`) with conditions, or `request_skill_changes` to
  add/remove/replace skills. Only accept `noneNeeded` with a solid justification.

## When planning, delegating and verifying

- Each goal lists the installed skills relevant to it (`skills`). When writing
  the plan or reviewing a delegation, check that relevant skills are listed.
- When verifying a result, check that the goal's skills were actually applied; if
  a relevant skill was ignored, reject (`request_result_changes`).
- Read the actual `SKILL.md` to judge whether the researcher followed it.
