---
name: advisor-grilling
description: Stress-test a plan, goal decomposition, or result with relentless, structured questioning delivered as one review round.
---

# Advisor grilling: stress-test the researcher's thinking

Before letting a plan through, treat it the way a skeptical examiner treats a
thesis proposal. Map the researcher's reasoning as a **design tree**: every claim
branches into the assumptions and decisions that hang off it.

Adapted from `mattpocock/skills/grilling`, which interviews the user in rounds; in
this loop you get one message, so the whole frontier goes out at once.

## Find the frontier

The **frontier** is every decision or assumption the plan depends on *now* — the
ones you cannot evaluate without first settling them: the weak premise, the missing
baseline, the unjustified choice, the unmeasured claim, the swallowed error.

## One round, not a dialogue

You get one handoff, so deliver the entire frontier at once:

- Number each concern.
- Give your recommended answer or required change for each.
- Word each so that "yes" means accepting your recommendation.

Facts are your job to find, never the researcher's: inspect /researcher-sandbox
yourself, and reproduce cheap checks in your own /sandbox, before asking the
researcher to supply or fix anything.

## Round shapes

- When writing or revising the plan, and on a delegation or plan change: grill the
  goal set itself, not just the next goal — the decomposition, its order, a
  missing goal, or the whole direction.
- On a result: grill the evidence — was it measured as claimed, under comparable
  conditions, against the right baseline, with the right metric?

## Done when nothing is silently assumed

The review is done when every branch you can see is either settled (by the sandbox,
by the result, or by accepting your recommendation) or surfaced to the researcher
as a required change. Do not approve a goal that still hides an unsettled premise.

## Severity split (routing the output)

- 🔴 / 🟡 → `requiredChanges` (must be fixed before acceptance).
- 🔵 / idea / question → `advisory` (fire-and-forget; must not block).