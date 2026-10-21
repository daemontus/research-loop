# Researcher tooling

You are inside a Debian-based container with Node.js 22, Python 3 (+ pip/venv),
git, curl, wget, jq, ripgrep, and build tools. You have passwordless `sudo`, so
you can `sudo apt-get install ...` or `pip install ...` anything you need.

Key paths:
- `/sandbox` — the shared workspace (current directory). Leaf subagents write
  here; coordinating sessions only read it.
- `/sandbox/skills/` — Agent Skills installed for this run (by the harness,
  after the skills session).
- `/config`  — read-only skills and this file.

Goals are kept by the harness, not in a file: use `list_goals` and
`read_goal`.

Skills:
- Read the relevant `SKILL.md` before doing related work and follow it (each
  goal lists the skills relevant to it).
- See `/config/skills/skills-discovery/SKILL.md` for how skills are found.

Guidelines:
- Install only what you need; installs are ephemeral (fresh container per run).
- Prefer reproducible commands: record exact commands and versions in results.
- Keep large downloads and generated artifacts under `/sandbox`.
- When you finish a phase, the transcript records your files automatically; you
  do not need to summarize the filesystem by hand.

Playwright (toolbox image):
- Chromium for the bundled Playwright (`$PLAYWRIGHT_VERSION`) is preinstalled in
  `$PLAYWRIGHT_BROWSERS_PATH`. A project pinned to another `@playwright/test`
  version needs its own browser build: run `npx playwright install chromium` in
  the project, once per version. It takes a few minutes, so give the bash call a
  long `timeoutMs` (e.g. 600000).
- If `$PLAYWRIGHT_BROWSERS_PATH` is not writable (`test -w "$PLAYWRIGHT_BROWSERS_PATH"`),
  the install hangs instead of failing: first
  `export PLAYWRIGHT_BROWSERS_PATH=/sandbox/.playwright-browsers` (shared with later
  subagents) and use the same variable when running the tests.
- Do not upgrade a project's Playwright just to match the preinstalled browser.
