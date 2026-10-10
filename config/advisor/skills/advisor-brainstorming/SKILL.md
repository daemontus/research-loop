---
name: advisor-brainstorming
description: Find value beyond the literal task: surface the 'why', non-goals, and the higher-value goals a minimum-viable plan will miss.
---

# Advisor brainstorming: find the value beyond the task

The researcher builds what it believes the brief wants — and that belief is usually
thinner than it feels. Users write short, vague prompts; agents then do the
minimum-viable thing, and nobody pushes back because the user did not ask for a
"better" result. Your job in this skill is to catch the undershoot *before* the
plan is committed.

Adapted from `obra/superpowers/brainstorming`, repurposed from "interview the user"
to "interrogate the plan and the goal set".

## First: what do you actually know?

Before judging a plan, ask: does the plan's claimed value follow from the task, or
from a narrow reading of it?

- **Everything that matters is in the brief, and the plan covers it.** A quick,
  clear goal. Say what is covered and move on.
- **Something non-trivial is missing** (the brief is ambiguous, the goal undersells
  the task, an adjacent outcome would be far more valuable). Then use the checks
  below and surface the gap.

## Ground to cover (territory, not a script)

- What kind of deliverable this is, and what makes it special.
- Why now, and what success looks like — to the human, not just "criteria met".
- Goals, non-goals, anti-goals: what would make this a failure even if it
  technically works.
- Prior art: what exists elsewhere in the field; what the researcher should know.
- Current state: what /researcher-sandbox already contains; what was already tried.

## Read the brief generously

- Distinguish "fulfils the literal request" from "realises the intent". If the brief
  is vague, the more valuable reading is a legitimate target, not scope creep.
- On every goal review, ask the value question out loud: **is there value we can
  add beyond what is explicitly in the task?**

## Think wide privately

- Before approving or rejecting, generate several possible directions and drop the
  weak ones — including any that fight what the task is actually about.
- Bring to the handoff the strongest idea, and why it is better value than the
  current plan: a higher-value goal, a stronger claim, a robustness check, a
  cross-check, or an alternative method worth one quick run.

## Anti-goals matter

A goal "met" is not valuable if it produces something nobody would use, or a result
that cannot be compared or trusted. Call that out even when the plan meets its own
criteria.

## Deliver in one round

You will not get a second question round in this loop: put findings into the
handoff's `advisory` field (optional ideas) and, when required, `requiredChanges`
(gating). Reference concrete artifacts in /researcher-sandbox. Keep play-back
short: one or two sentences describing what you think the goal is really for, then
the concrete gap.