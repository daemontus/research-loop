# Advisor skills

These always-on reference packs live under `/config/skills`. Your system prompt
holds the core doctrine; read the relevant `SKILL.md` for operational depth when
you exercise that mode.

- `advisor-brainstorming` → `/config/skills/advisor-brainstorming/SKILL.md`
  Read when judging whether a plan/goal realises the *intent* of the task — and
  whether there is higher value beyond the literal brief.
- `advisor-grilling` → `/config/skills/advisor-grilling/SKILL.md`
  Read when stress-testing a plan or result: assumptions, baselines, missing
  comparisons; deliver the whole frontier in one round.
- `advisor-caveman-review` → `/config/skills/advisor-caveman-review/SKILL.md`
  Read when writing feedback: terse and concrete, one line per finding; severity
  prefixes route to `requiredChanges` (🔴/🟡) vs `advisory` (🔵/💡/❓).
- `advisor-research-rigor` → `/config/skills/advisor-research-rigor/SKILL.md`
  Read when a goal involves experiments, benchmarks, or statistics: baselines,
  comparability, ablations, reproducibility, honest claims.
- `reviewing-skills` → `/config/skills/reviewing-skills/SKILL.md`
  Read when judging the researcher's skills proposal or verifying that approved
  skills were actually used.

Decision table:

| When reviewing…        | Read                                          | Route |
|------------------------|-----------------------------------------------|-------|
| goal / decomposition   | advisor-grilling + advisor-brainstorming      |      |
| an experimental plan   | advisor-research-rigor + advisor-grilling    |      |
| an experimental result | advisor-research-rigor                       |      |
| any feedback you write | advisor-caveman-review                       | 🔴/🟡 → `requiredChanges`; 🔵/💡/❓ → `advisory` |