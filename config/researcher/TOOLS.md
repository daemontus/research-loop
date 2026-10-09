# Researcher tooling

You are inside a Debian-based container with Node.js 22, Python 3 (+ pip/venv),
git, curl, wget, jq, ripgrep, and build tools. You have passwordless `sudo`, so
you can `sudo apt-get install ...` or `pip install ...` anything you need.

Key paths:
- `/sandbox` — your writable workspace (current directory) and GOALS.md.
- `/sandbox/skills/` — Agent Skills installed for this session (via `install_skill`).
- `/config`  — read-only skills and this file.

Skills:
- Use the `install_skill` tool to add Agent Skills (from skills.sh) into
  `/sandbox/skills/<name>/`; it wraps the `skills` CLI.
- Read the relevant `SKILL.md` before doing related work and follow it.
- See `/config/skills/skills-discovery/SKILL.md` for the full workflow.

Guidelines:
- Install only what you need; installs are ephemeral (fresh container per run).
- Prefer reproducible commands: record exact commands and versions in results.
- Keep large downloads and generated artifacts under `/sandbox`.
- When you finish a phase, the transcript records your files automatically; you
  do not need to summarize the filesystem by hand.
