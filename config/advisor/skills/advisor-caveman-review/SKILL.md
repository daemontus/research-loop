---
name: advisor-caveman-review
description: Terse, concrete advisor feedback — one line per finding with location, problem, and fix; no throat-clearing.
---

# Advisor caveman review

Write review feedback terse and actionable. One line per finding. Location
(artifact or step), problem, fix. No throat-clearing.

Adapted from `juliusbrussee/caveman/caveman-review`, which reviews code diffs;
here the "location" is a step, artifact, or claim in the researcher's workspace.

## Format

`<artifact or step>: <problem>. <fix>.`

## Severity prefixes (route them)

- `🔴 must:` — broken or wrong; the goal cannot be accepted without it (→ `requiredChanges`).
- `🟡 risk:` — works but fragile or non-comparable: missing baseline, wrong split, swallowed error (→ `requiredChanges`).
- `🔵 nit:` — improvement; the researcher may ignore (→ `advisory`).
- `❓ q:` — genuine question, not a suggestion (→ `advisory`).
- `💡 idea:` — a higher-value direction the researcher may adopt (→ `advisory`).

## Drop

- "I noticed that…", "It seems like…", "You might want to consider…"
- "This is just a suggestion but…" — use `nit:`/`idea:` instead
- "Great work!", "Looks good overall but…" — say it once at the top, not per finding
- Restating what the artifact already shows — you can read the file
- Hedging ("perhaps", "maybe", "I think") — if unsure, use `q:`

## Keep

- Exact artifact paths and step numbers
- Exact command/config names in backticks
- A concrete fix ("re-run with seed X; compare against baseline Y"), not "consider
  improving this"
- The *why* when the fix is not obvious from the problem

## Example

❌ "I noticed that on step 3 you are not comparing against a random baseline, which
could mean the improvement is not real. You might want to add a baseline."

✅ `step 3: 🟡 risk: no random baseline ⇒ gain may be noise. Add a shuffled-gene baseline and report the delta.`

## Auto-clarity

Drop terse mode for methodological disagreements that need the why, and for
security/ethics-class findings. For those, one normal paragraph, then resume terse.

## Boundaries

Reviews only. It does not write the fix, does not run the researcher's tools, and
does not approve or request changes by itself — it produces the review style you
then route to `requiredChanges` vs `advisory` in your handoff.