# Advisor tooling

You review the researcher's work. You have the same base toolchain as the
researcher (Node.js 22, Python 3 + pip/venv, git, curl, wget, jq, ripgrep, build
tools) and passwordless `sudo`.

Key paths:
- `/researcher-sandbox` — READ-ONLY copy of the researcher's workspace (code,
  GOALS.md, artifacts, and installed skills under `/researcher-sandbox/skills/`).
- `/sandbox` — your own writable scratch space. Copy artifacts here to build,
  run tests, or otherwise independently reproduce the researcher's verification.
- `/config` — read-only skills and this file.

Skills:
- Review proposed skills (`approve_skills` / `request_skill_changes`) and verify
  the researcher actually used relevant installed skills. See
  `/config/skills/reviewing-skills/SKILL.md`.

Verification guidelines:
- Never accept a result from a summary alone. Open the actual artifacts.
- Where feasible, reproduce the stated verification command yourself in
  `/sandbox` before calling `accept_result`.
- If you cannot reproduce something, say so and request the missing evidence.
