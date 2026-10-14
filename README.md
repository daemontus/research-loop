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

- **Task / Goals** (left) — the task text plus the researcher's `GOALS.md`,
  rendered from Markdown to HTML with a standard CommonMark parser (vendored
  `marked` + `DOMPurify` under `control-plane/ui/vendor/`; regenerate with
  `npm run vendor:ui`).
- **Transcript** (middle) — the full, chronological transcript. It always shows
  the complete history: on (re)connect the server replays every entry read from
  disk, sorted by time, then streams live updates over SSE. Message content is
  collapsed to 5 lines with a "Show more" toggle; agent messages, handoff text
  and summaries/feedback render as Markdown (tool output stays monospace);
  reasoning and tool-call arguments are collapsible; handoff payloads (plans,
  acceptance criteria, required changes, feedback, ...) render as structured
  fields rather than raw JSON. A toolbar above it searches entries by text and
  filters them by author.
- **Overview** (right) — one clickable item per high-level phase (plan
  proposed/approved/changed, result submitted/accepted/changed, task completion,
  human decisions), grouped into sections: setup, one per goal (titled from its
  plan, with a live status: planning / in progress / result in review / changes
  requested / done), and task completion. The pane header counts goals done.
  Clicking an item scrolls the transcript to it and highlights it; the current
  phase is highlighted as you scroll; section headers collapse.

Both side panes can be resized by dragging the dividers and collapsed to a thin
rail («/»); sizes and collapsed state are remembered per browser. When the run
awaits your approval, the Task/Goals pane (which holds the approval controls)
opens automatically.

While an agent is generating, its thinking and response stream into a dashed
"streaming" preview bubble as tokens arrive from the provider (tool calls show
as "→ calling <tool>…"). The preview is replaced by the finished message once it
lands in the transcript. Streaming is display-only: agents batch deltas every
~250 ms to `POST /api/partial`, the control plane relays them over SSE and never
writes them to disk, so transcripts, resume and stats are unaffected. Reloading
the page mid-message drops that message's preview (the finished message still
appears). Providers that do not stream show the text in one or a few chunks.

The header shows the run's label (the `--task-file` name, else the run
directory's name; also the browser tab title, to tell parallel runs apart), live
totals (handoffs, tokens consumed — hover for the in/out/cached breakdown, who
the state machine expects to act next) and a per-agent **liveness** indicator
("active", "idle N m", "offline", or "finished").

When the run needs you or ends, the tab title and favicon change ("● Needs your
approval", "✓ Finished", "✗ Aborted", with a yellow/green/red badge). The bell
button enables desktop notifications for the same events while the tab is not
focused; browsers only allow these on `localhost`/`127.0.0.1` (or HTTPS), so the
button is hidden when the UI is opened through a LAN IP. Liveness is informational only — there are no heartbeat
timeouts, so an agent may legitimately "think" or run a tool for hours without
being killed.

The server binds to `127.0.0.1` by default; pass `--host <ip>` (e.g. `0.0.0.0`)
and/or `--port <n>` to change the bind address and port. All `/api/*` endpoints
(including the transcript stream and progress) require the session token, which
the orchestrator includes in the URL it opens (`/?token=...`); it is not embedded
in the served page.

Docker on Linux: containers reach the host via `host.docker.internal`, which on
Linux is the Docker bridge gateway (typically `172.17.0.1`), not loopback. With a
loopback `--host` the orchestrator therefore also listens on the bridge gateway
address (same port). If that fails (e.g. rootless Docker or a custom network), it
prints a warning; use `--host 0.0.0.0` instead. The same applies to an LLM
provider on `localhost`: it must listen on an address the containers can reach.

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

### Batteries-included agent image (toolbox)

The default agent image is deliberately slim: agents fetch extra tooling at
runtime with their passwordless sudo, but every run starts from a fresh
container, so commonly-used toolchains get reinstalled over and over. To bake
them in, build an alternative image from the same `Dockerfile.agent` by enabling
optional build args:

```bash
docker build -f Dockerfile.agent \
  --build-arg INSTALL_RUST=1 \
  --build-arg INSTALL_UV=1 \
  --build-arg INSTALL_LATEX=1 \
  -t research-loop-agent-toolbox:latest .
```

Each arg is an independent opt-in (default `0`); combine the ones you want:

| Build arg | Default | Adds |
|---|---|---|
| `INSTALL_RUST` | `0` | Rust toolchain via rustup (stable, minimal) — `rustc`/`cargo` on PATH, tools under `/opt/rustup` + `/opt/cargo` |
| `INSTALL_UV` | `0` | `uv` (Python toolchain manager) in the agent's home, plus pre-installed CPython 3.11 and 3.12 so `uv venv`/`uv run` don't re-download them |
| `INSTALL_LATEX` | `0` | light TeX Live toolbox: `pdflatex`, common formats/fonts, TikZ/pgf (`texlive-pictures`), and `latexmk` |

Then point your runs at it with `--image`:

```bash
node orchestrator/run.mjs --task "..." \
  --image research-loop-agent-toolbox:latest \
  --researcher-model einfra:qwen3.8-27b \
  --advisor-model einfra:deepseek-v4-flash
```

The image is used for **both** roles (researcher and advisor). Everything is
installed under directories owned by the non-root `agent` user and stays on
PATH for its login shells and `sudo`, so agents can still install anything extra
per task (and can even update the bundled Rust/uv at runtime).

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
| `--max-handoffs` | 0 (unlimited) | abort after this many researcher goal steps (proposals + results); set a value to enforce |
| `--wallclock-ms` | 0 | overall wall-clock budget (`0` = disabled) |
| `--max-turns-per-phase` | 1000 | agent turns allowed per phase (`0` = unlimited) |
| `--abort-timeout-ms` | 0 | per-attempt window before an in-flight turn is aborted and retried (`0` = disabled) |
| `--phase-timeout-ms` | 0 | hard per-phase wall clock (`0` = disabled) |
| `--thinking` | medium | reasoning effort |
| `--host` | `127.0.0.1` | control-plane/WebUI bind address (`0.0.0.0` for all interfaces) |
| `--port` | 0 | control-plane port (0 = random) |
| `--run-dir` | `runs/<timestamp>` | output directory |
| `--resume <id\|dir>` | — | resume an interrupted session (see below) |
| `--resume-prompt <text>` | — | extra instructions injected into the resume prompt |
| `--view <id\|dir>` | — | open the WebUI for a finished run, no agents |
| `--print-jobs` | off | print the agent job JSON (secrets redacted) and exit |

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

## Advisor review doctrine

The advisor reviews every plan and result and is explicitly expected to be a
*harsher critic of the high-level solution*, not just a goals-checker. Its system
prompt carries an always-on **advisor doctrine** (verify / red-team / explore) and a
mandatory exploratory self-check on every review — including "is there value we can
add beyond what is explicitly in the task?" — so a short, vague brief does not leave
the researcher doing the minimum-viable thing.

Feedback is split into **gating** vs **advisory**: `requiredChanges`/`conditions`
hard-block a goal, while the optional `advisory` field carries fire-and-forget
recommendations (higher-value directions, extra analyses) that never block
acceptance. The researcher is instructed to weigh `advisory` items and either adopt
or briefly justify declining them. The advisor's reasoning depth lives in four
always-on reference packs under `config/advisor/skills/` (adapted from skills.sh):
`advisor-brainstorming` (value beyond the brief), `advisor-grilling` (stress-test
plans/results), `advisor-caveman-review` (terse, concrete feedback), and
`advisor-research-rigor` (baselines, comparability, ablations, reproducibility),
and a decision-tree index in `config/advisor/skills/README.md`.

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

For a provider listed in `pi_config.json`, the key is resolved from (in order)
the provider's `apiKeyEnv`, the conventional env var for that provider id (e.g.
`OPENAI_API_KEY` for an `openai` entry), then `~/.pi/agent/auth.json` (or
`PI_AUTH_FILE` / `PI_AUTH_PATH`). `localhost` base URLs are rewritten to
`host.docker.internal` for Docker runs.

A provider *not* listed in `pi_config.json` is looked up in pi-ai's built-in
catalog (e.g. `opencode-go`, `opencode`, `anthropic`, `openrouter`), with its
models' context/output limits taken from the catalog (`--*-context-window` /
`--*-max-tokens` still override them). Its key comes from `auth.json` or the
provider's standard env var. The orchestrator resolves the key on the host and
passes it to the agents, so it does not need to be set inside the containers.

### OpenCode Go

```bash
export OPENCODE_API_KEY=...
node orchestrator/run.mjs --task "..." \
  --researcher-model opencode-go:deepseek-v4-flash::high \
  --advisor-model opencode-go:minimax-m3
```

Only models in the installed pi-ai catalog are known (`node -e` on
`node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json` lists
them). To use a newer model before pi-ai ships it, add it to the built-in
provider in `pi_config.json` (no `baseUrl`), cloning a similar catalog model's
settings with `like`; other fields override the clone:

```json
{ "id": "opencode-go", "models": [
  { "id": "deepseek-v4.1-flash", "like": "deepseek-v4-flash", "input": ["text", "image"] }
] }
```

Such an entry only adds models; the rest of the catalog stays available. The
orchestrator resolves the definition on the host and passes it to the agents.

OpenCode requires harnesses to identify themselves, so every request to an
OpenCode model (provider `opencode`/`opencode-go`, or any base URL on
`opencode.ai`) carries `User-Agent: research-loop/<version>`,
`x-opencode-client: research-loop`, and `x-opencode-session: <uuid>`. The session
id is derived from the run id and the role (one per agent, stable across
`--resume`). Other providers keep pi-ai's default `pi (...)` User-Agent. See
`agent/lib/client-identity.mjs`.

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
    partial-stream.mjs     # live thinking/text streaming to the WebUI
    client-identity.mjs    # provider-required identification (OpenCode headers)
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
  model's provider had no usable credential. A `pi_config.json` provider needs
  its `apiKeyEnv` (e.g. `OLLAMA_EINFRA_API_KEY`), the conventional env var for
  that provider id, or an entry in `~/.pi/agent/auth.json`; a built-in catalog
  provider (e.g. `opencode-go`) needs its standard env var (`OPENCODE_API_KEY`)
  or an `auth.json` entry, and the model id must exist in the catalog. The orchestrator fails at startup
  if it cannot resolve a key; the container also refuses to start without one.
- **A phase produces no handoff.** The harness nudges the model up to 3 times to
  end its turn with a control tool; if it still fails, or the provider errors,
  the agent exits non-zero and the orchestrator aborts the session with the
  reason — it never waits forever. Any agent process/container exit before the
  session ends (whatever the exit code) aborts the run; a slow agent is never
  timed out as long as its process is alive.
- **Ctrl-C.** Interrupting the orchestrator aborts the session and stops both
  containers.

## Resuming and reviewing runs

Long sessions sometimes die (provider outage, host reboot). New containers start
fresh, but the sandbox and transcripts on disk persist, so a run can be
continued:

```bash
node orchestrator/run.mjs --resume runs/<id> \
  --resume-prompt "Re-examine G3; the reviewer disagreed with the permutation design."
```

The control-plane state is rebuilt from `runs/<id>/transcripts/session.jsonl`,
so the loop resumes in whatever state it was in (plan review, result review,
awaiting human, ...) and the resume prompt is delivered to the agent expected to
act. The prompt always warns the agent that its container/environment was rebuilt
from scratch and it must reconstitute installed tooling, re-read GOALS.md and its
notes, and *continue* (not restart) the task. The task, models and
`--skip-skills` of the original run are restored from `run.json` (written at
startup), `session.json` (written on a clean exit), or, for older runs, the task
from the session log; flags override them.

To review a finished run without starting containers:

```bash
node orchestrator/run.mjs --view runs/<id>
```

This serves the WebUI with the run's final state (goals, transcripts, statistics)
and no agents, until you interrupt it.

## Reliability hardening

Long sessions are protected against the common derail modes:

- **Provider retries**: `streamSimple` is called with `maxRetries` (default 4)
  and `maxRetryDelayMs` (60s), so transient 5xx/408/network errors are retried by
  pi-ai instead of aborting the run.
- **Turn-level recovery**: aborted turns, HTTP 429, and context-overflow `400`s
  trim to the last consistent point, compact, and continue (bounded per phase).
- **Compaction reclaims file bodies**: older tool-call arguments (e.g.
  `write_file` content) are truncated, in addition to stripping tool output and
  stale reasoning.
- **Prompt size accounts for cache hits**: the reported prompt is the full
  prompt (`input + cacheRead + cacheWrite`), as pi-ai defines it, not just the
  uncached delta — so providers that report most of the prompt as `cacheRead`
  (e.g. vLLM) still trigger compaction correctly.
- **Mid-phase proximity compaction**: when a context window is known and the
  reported prompt approaches it, the runner stops the phase, compacts, and
  continues — even with providers that refuse to truncate and return a `400`
  ("exceeds the context ... never truncated") instead of a `length` stop. Such
  rejections are also recognized as context overflow and recovered rather than
  retried as transient errors.
- **Timeouts are optional and off by default.** By default a run is only bounded
  by progress (`--max-handoffs`) and the cap on consecutive invalid handoffs, so long sessions keep
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
