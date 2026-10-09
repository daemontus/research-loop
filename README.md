# research-loop

A two-agent research assistant built on [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi).

A **researcher** agent decomposes a broad research task, proposes plans, executes
them, and reports results. An **advisor** agent reviews every plan before it is
executed and verifies every result before a goal is considered met. The loop runs
until a human approves final task completion.

Both agents run as long-lived, separately sandboxed Docker containers and alternate
turns through a host-side control plane. Each container keeps running for the whole
session, so installed tools and conversation state persist between handoffs.

```
                              host
        ┌───────────────────────────────────────────────────────┐
        │  orchestrator (run.mjs)                               │
        │    start containers · budgets · cleanup               │
        ├───────────────────────────────────────────────────────┤
        │  control plane (server.mjs)                           │
        │    HTTP broker (long-poll inbox) · state machine      │
        │    SSE transcript stream · WebUI · session audit      │
        └───────┬───────────────────────────────────┬───────────┘
                │ host.docker.internal              │
   ┌────────────▼─────────────┐        ┌────────────▼─────────────┐
   │ researcher container     │        │ advisor container        │
   │  /sandbox (rw)  ← RS     │        │  /sandbox (rw) ← AS      │
   │  /config (ro)            │        │  /researcher-sandbox (ro)│
   │  /transcripts (rw)       │        │  /config (ro)            │
   │  pi Agent + control tools│        │  /transcripts (rw)       │
   └──────────────────────────┘        └──────────────────────────┘
```

## Turn-taking protocol

Each agent works in phases. A phase ends only when the agent calls a **control
tool** (which sets a handoff and stops the agent loop). The runner then sends an
envelope to the broker, which validates the transition and routes it to the peer.

| Researcher control tool | Advisor control tool | Meaning |
|---|---|---|
| `submit_plan` | `approve_plan` / `request_plan_changes` | plan review |
| `submit_result` | `accept_result` / `request_result_changes` | result review |
| `request_task_completion` | `accept_task_completion` / `request_task_changes` | task sign-off |

```
RESEARCHER_DECOMPOSE → ADVISOR_REVIEW_PLAN → RESEARCHER_EXECUTE
        ↑                                            │
        │                      ADVISOR_REVIEW_RESULT ←┘
        │                              │
        └────────── accept_result ─────┘
                                       │
        request_task_completion → ADVISOR_REVIEW_TASK → AWAITING_HUMAN → DONE
```

`submit_plan` may be called at any time, not just for subdivision: the researcher
can **revise** scope, method, acceptance criteria, or replace a goal entirely
(set `revisionOf` + `rationale`). This lets it escape infeasible or
under-specified goals instead of forcing an approach that no longer fits.

Illegal transitions are rejected by the state machine and answered with a
correction prompt, so a confused model cannot deadlock the session.

## GOALS.md

The researcher owns `GOALS.md` in its sandbox; the advisor reads it (read-only).
Goals have stable ids and statuses:

```markdown
# Research task
<task>

## Goals
### G1 — Survey prior work [status: done]
- intent: ...
- acceptance criteria:
  - ...
- subgoals: G1.1, G1.2
- artifacts: notes/survey.md
### G2 — Draft an approach [status: in_progress]
...
```

The WebUI shows the live `GOALS.md`.

## Human-in-the-loop

The advisor cannot end the session. When the advisor accepts task completion the
session enters `AWAITING_HUMAN`; the WebUI shows an approval panel:

- **Approve completion** → `DONE`
- **Extend budget** → resume with more budget
- **Reject / keep working** → send the agents back to work

A human can also inject a steering message to either agent at any time.

## Transcripts & WebUI

Both agents append JSONL transcripts to a host directory mounted outside the
sandbox (`runs/<id>/transcripts/{researcher,advisor}.jsonl`), and the control
plane records `session.jsonl`. The WebUI (`http://127.0.0.1:<port>/?token=...`)
has three panes:

- **Transcript** (left) — the full, chronological transcript. It always shows
  the complete history: on (re)connect the server replays every entry read from
  disk, sorted by time, then streams live updates over SSE. Message content is
  collapsed to 5 lines with a "Show more" toggle; reasoning and tool-call
  arguments are collapsible; handoff payloads (plans, acceptance criteria,
  required changes, feedback, ...) render as structured fields rather than raw
  JSON.
- **Overview** (middle) — one clickable item per high-level phase (plan
  proposed/approved/changed, result submitted/accepted/changed, task completion,
  human decisions). Clicking scrolls the transcript to that phase and highlights
  it; the current phase is highlighted as you scroll.
- **Goals** (right) — the researcher's `GOALS.md`, rendered from Markdown to
  HTML.

The server binds to `127.0.0.1`. All `/api/*` endpoints (including the
transcript stream and progress) require the session token, which the orchestrator
includes in the URL it opens (`/?token=...`); it is not embedded in the served
page.

## Quick start

```bash
npm install

# Fully offline demo (no API keys): fake models, two local processes, auto-approve.
node orchestrator/run.mjs --task "Design a parallel Apply algorithm for BDDs" \
  --faux --auto-approve

# Real run (local processes) using credentials from env or ~/.pi/agent/auth.json
node orchestrator/run.mjs --task "Design a parallel Apply algorithm for BDDs" \
  --researcher-model einfra:qwen3.8-27b \
  --advisor-model einfra:deepseek-v4-flash \
  --local

# Real run in Docker (build the image first)
docker build -f Dockerfile.agent -t research-loop-agent:latest .
node orchestrator/run.mjs --task "..." \
  --researcher-model einfra:qwen3.8-27b \
  --advisor-model einfra:deepseek-v4-flash
```

Open the printed UI URL to watch and to approve completion.

### Orchestrator flags

| Flag | Default | Description |
|---|---|---|
| `--task` / `--task-file` | — | the broad research task |
| `--initial-sandbox` | — | host folder copied into the researcher sandbox before the session |
| `--researcher-model` / `--advisor-model` | `einfra:qwen3.8-27b` / `einfra:deepseek-v4-flash` | `provider:model::effort` |
| `--config` | `./pi_config.json` | provider definitions |
| `--image` | `research-loop-agent:latest` | Docker image |
| `--local` | off | run agents as local processes instead of Docker |
| `--docker` | off | force Docker even with `--faux` (test the container path offline) |
| `--faux` | off | offline scripted demo (implies `--local` unless `--docker`) |
| `--auto-approve` | off | auto-approve final completion (for testing) |
| `--skip-skills` | off | skip the skills-discovery phase and start planning immediately |
| `--no-open` | off | do not open the WebUI in a browser (URL is still printed) |
| `--no-model-discovery` | off | skip querying the provider's `/models` for context/output limits |
| `--researcher-context-window` / `--advisor-context-window` | discovered/config | override a model's context window |
| `--researcher-max-tokens` / `--advisor-max-tokens` | discovered/config | override a model's maximum output tokens |
| `--max-handoffs` | 200 | abort after this many researcher goal steps (proposals + results) |
| `--wallclock-ms` | 0 | overall wall-clock budget (`0` = disabled) |
| `--max-turns-per-phase` | 1000 | agent turns allowed per phase (`0` = unlimited) |
| `--abort-timeout-ms` | 0 | per-attempt window before an in-flight turn is aborted and retried (`0` = disabled) |
| `--phase-timeout-ms` | 0 | hard per-phase wall clock (`0` = disabled) |
| `--thinking` | medium | reasoning effort |
| `--port` | 0 | control-plane port (0 = random) |
| `--run-dir` | `runs/<timestamp>` | output directory |
| `--print-jobs` | off | print the container job JSON and exit |

## Seeding the researcher sandbox

Pass `--initial-sandbox <dir>` to copy a host folder into the researcher's
sandbox before the session starts. Use this to provide datasets, papers, starter
code, or reference material for the task:

```bash
node orchestrator/run.mjs --task "Reduce this Boolean network while preserving attractors" \
  --initial-sandbox ./resources/bn-reduction \
  --researcher-model einfra:qwen3.8-27b \
  --advisor-model einfra:deepseek-v4-flash
```

The contents are copied (recursively) into `runs/<id>/researcher-sandbox/`, which
the researcher sees as `/sandbox` and the advisor sees read-only as
`/researcher-sandbox`. The initial resource listing is also included in the
researcher's opening message so it knows what it has. Everything else (installed
tools, generated files, GOALS.md) is written on top of this seed.

## Model context limits

The researcher and advisor may use different models with different context
windows. By default **no limits are fabricated**: no `max_tokens` cap is sent
and no context window is assumed, so the provider's own defaults apply. Limits
are only applied when set or detected, highest priority first:

1. CLI flags `--researcher-context-window/--researcher-max-tokens` (and advisor
   equivalents);
2. `contextWindow` / `maxTokens` on the model entry in `pi_config.json`;
3. **auto-discovery** from the provider's OpenAI-compatible `/models` endpoint
   (LiteLLM `max_input_tokens`/`max_output_tokens`, vLLM `max_model_len`,
   OpenRouter `top_provider.*`), using the resolved API key.

If the provider does not report limits and you want a cap, set them yourself in
`pi_config.json`:

```json
{ "id": "qwen3.8-27b", "input": ["text", "image"], "contextWindow": 262144, "maxTokens": 32000 }
```

When a context window is known, pi-ai clamps `input + max_tokens` to fit and the
harness **compacts proactively** before a phase as the reported input size
approaches it. Regardless of configuration, a context-length rejection from the
provider (LiteLLM/vLLM `400`) is recovered: the failed turn is trimmed, history
is compacted, and the request is retried instead of aborting.

## Skills

Before planning, the session runs a **skills-discovery phase** (`--skip-skills`
to disable it):

```
RESEARCHER_SKILLS → ADVISOR_REVIEW_SKILLS → RESEARCHER_INSTALL_SKILLS → planning
```

- The researcher searches [skills.sh](https://skills.sh) (`npx skills find`),
  inspects candidates (relevance + security audits), and proposes a set with
  `propose_skills` (or `noneNeeded` with justification).
- The advisor approves or requests changes (`approve_skills` /
  `request_skill_changes`).
- The researcher installs approved skills with the harness **`install_skill`**
  tool, which wraps the `skills` CLI and places each skill at
  `/sandbox/skills/<name>/` (SKILL.md + files). `confirm_skills_installed`
  reports them and is verified against that directory.
- Installed skills are re-scanned and injected into **every subsequent prompt**
  as an index; the agent reads the relevant SKILL.md on demand. The advisor reads
  the same files at `/researcher-sandbox/skills/...`.
- **Use is enforced**: plans must list `skillsToUse`, results must report
  `skillsUsed`, and the advisor rejects plans/results that ignore a relevant
  installed skill.

With `--skip-skills` (or skills you drop in yourself) the agents are still
instructed to use anything under `/sandbox/skills/`.

The image ships the `skills` CLI and `DISABLE_TELEMETRY=1`. Skill guidance lives
in `config/researcher/skills/skills-discovery/SKILL.md` and
`config/advisor/skills/reviewing-skills/SKILL.md`.

## Configuration

Providers use the same format as `biodivine-model-sniffer/pi_config.json`:

```json
{
  "providers": [
    {
      "id": "einfra",
      "baseUrl": "https://llm.ai.e-infra.cz/",
      "apiKeyEnv": "OLLAMA_EINFRA_API_KEY",
      "models": [{ "id": "deepseek-v4-flash", "input": ["text"] }]
    }
  ]
}
```

Credentials are resolved from (in order) the provider's `apiKeyEnv`, built-in
provider env vars (e.g. `OPENAI_API_KEY`), then `~/.pi/agent/auth.json`
(or `PI_AUTH_FILE` / `PI_AUTH_PATH`). `localhost` base URLs are rewritten to
`host.docker.internal` for Docker runs.

## Repository layout

```
agent/
  main.mjs                 # container entrypoint: session loop
  lib/
    agent-runner.mjs       # pi Agent + retries + compaction + handoffs
    control-tools.mjs      # submit_plan / accept_result / ...
    protocol.mjs           # envelopes, kinds, rendering, validation
    model-providers.mjs    # providers, auth, model resolution
    tools.mjs              # bash / read_file / write_file / edit_file / ...
    prompts.mjs            # role system prompts
    transcript.mjs         # JSONL transcript writer
    abort-retry.mjs        # aborted/429 retry (from pi-retrieve)
    context-compaction.mjs # length-stop compaction (from pi-retrieve)
    workspace-paths.mjs    # sandbox/config/prefetch/extra-root resolution
    skills.mjs             # skill index loader
    broker-client.mjs      # HTTP long-poll client
control-plane/
  server.mjs               # HTTP + SSE + static UI
  broker.mjs               # inboxes, routing, session logging
  state-machine.mjs        # pure turn-taking state machine
  ui/index.html            # single-file WebUI
orchestrator/
  run.mjs                  # launch, budgets, cleanup, summary
  docker.mjs               # docker run helpers
  credentials.mjs          # host-side credential resolution
config/{researcher,advisor}/
  TOOLS.md                 # role tooling notes
  skills/                  # optional skill packs (SKILL.md + README.md)
Dockerfile.agent           # single image for both roles
```

## Preserved harness features

The agent runtime intentionally mirrors `biodivine-model-sniffer`'s retrieval
sidecar so its operational behavior is preserved:

- **abort retries** from the last consistent transcript tail,
- **HTTP 429 / overload retries** with backoff,
- **context compaction** on length stops (tool bodies stripped, old reasoning
  dropped, workspace snapshot injected),
- provider/model/auth handling and `provider:model::effort` parsing,
- JSONL transcripts with serialized thinking, tool calls, and results.

## Development

```bash
npm test                       # unit + in-process end-to-end (faux provider)
npm test -- test/agent-loop.test.mjs
```

The end-to-end test drives the full protocol through the real broker using
pi-ai's `fauxProvider`, with no network access.

## Troubleshooting

- **`Provider is not configured` / session aborts immediately.** The selected
  model's provider had no usable credential. `pi_config.json` providers need
  their `apiKeyEnv` set (e.g. `OLLAMA_EINFRA_API_KEY`), a built-in provider env
  var, or an entry in `~/.pi/agent/auth.json`. The orchestrator fails at startup
  if it cannot resolve a key; the container also refuses to start without one.
- **A phase produces no handoff.** The harness nudges the model up to 3 times to
  end its turn with a control tool; if it still fails, or the provider errors,
  the agent exits non-zero and the orchestrator aborts the session with the
  reason — it never waits forever.
- **Ctrl-C.** Interrupting the orchestrator aborts the session and stops both
  containers.

## Reliability hardening

Long sessions are protected against the common derail modes:

- **Provider retries**: `streamSimple` is called with `maxRetries` (default 4)
  and `maxRetryDelayMs` (60s), so transient 5xx/408/network errors are retried by
  pi-ai instead of aborting the run.
- **Turn-level recovery**: aborted turns, HTTP 429, and context-overflow `400`s
  trim to the last consistent point, compact, and continue (bounded).
- **Compaction reclaims file bodies**: older tool-call arguments (e.g.
  `write_file` content) are truncated, in addition to stripping tool output and
  stale reasoning.
- **Timeouts are optional and off by default.** By default a run is only bounded
  by progress (`--max-handoffs`) and the rejection cap, so long sessions keep
  going; monitor them live in the WebUI. Set `--abort-timeout-ms` (per-attempt),
  `--phase-timeout-ms` (hard per-phase), or `--wallclock-ms` (overall) to a
  positive value to re-enable a bound.
- **When enabled**, an in-flight turn that exceeds `--abort-timeout-ms` is
  aborted and retried from the last consistent point with a fresh window; aborts
  are recognised whether the provider reports `stopReason: "aborted"` or an
  `"error"` whose message is an abort (e.g. "This operation was aborted").
- **Bounded broker polling**: if the control plane disappears, an agent exits
  after N failed polls instead of spinning forever.
- **Clean termination**: SIGTERM/SIGINT aborts and exits, so containers/processes
  are not orphaned.
- **Exactly one control tool per turn**: a second call is refused; the first
  handoff stands.
- **Illegal handoffs recover**: the broker rejects, queues a state-aware
  correction prompt, and the agent continues (it never crashes on the rejection).
- **Human notes are deferred** to the role expected to act and merged into its
  next handoff, so injecting a note cannot make an agent act out of turn.
- **`--max-handoffs`** counts researcher goal steps, not every message.

## Notes & limitations

- Containers are ephemeral: a crash loses runtime installs (a restart is a fresh
  container). During a normal session the container is never restarted.
- The advisor's view of the researcher's workspace is read-only and point-in-time
  at handoff; the sequence guarantees the researcher is idle while the advisor
  inspects.
- The control plane is a single local process; run one session per orchestrator
  invocation.
