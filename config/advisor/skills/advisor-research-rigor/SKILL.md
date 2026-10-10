---
name: advisor-research-rigor
description: Scientific-rigor reference for verifying experimental goals: baselines, comparability, ablations, reproducibility, and honest claims.
---

# Advisor research-rigor reference

Use when reviewing plans or results that make scientific or experimental claims
(models, benchmarks, statistics). Condensed from
`lllllllama/rigorpilot-skills`'s `research-rigor-principles.md` and
`deep-learning-experiment-principles.md`. These are reference judgment, not a rigid
checklist — apply them where they help.

## Core principles the researcher must honor (and you must check)

1. **No score chasing.** A metric gain must have explanatory value: a higher number
   is not enough unless it connects to a mechanism, hypothesis, or controlled
   comparison.
2. **No silent comparability breaks.** If evaluation conditions, datasets,
   preprocessing, metrics, checkpoints, or baselines change, the result is no longer
   directly comparable — demand the explanation.
3. **Novelty is earned, not claimed.** Novelty/significance are hypotheses until
   supported by literature contrast, ablation, and fair comparison. Reject
   "novel"/"SOTA" phrasing that the evidence does not support.
4. **Engineering fixes are not contributions.** Repairs, compatibility patches, and
   environment fixes must be labeled; they may enable research but are not method
   contributions.
5. **Baselines are preserved and meaningful.** A changed baseline must be disclosed
   and its comparability impact explained.
6. **Ablation thinking.** If the researcher claims a change matters, what experiment
   isolates its effect? Require it when the claim is central to the goal.
7. **Evidence is external, not asserted.** Commands, configs, seeds, dataset
   versions, hardware/runtime assumptions, logs, and metrics are the evidence; they
   belong in the workspace, reproducibly, not only in prose.

## When reviewing a result

- Reproduce the *stated* command yourself (copy artifacts to /sandbox) before
  believing it.
- Check the metric is measured the same way as the thing it is compared to.
- Demand that failed or partial runs be recorded plainly; hiding them changes the
  science.
- Distinguish verified facts from the researcher's inference, and flag which is
  which.

## When reviewing a plan

- Does it define the baseline/control, the metric, and the comparison up front?
- Does it record the context needed to reproduce (seeds, versions, environment)?
- Does it over-promise? Flag claims that need ablation or literature support as
  hypotheses, not conclusions.