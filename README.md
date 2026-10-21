# research-loop

A two-agent research assistant built on [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi).

A research loop of **researcher** and **advisor** agents. The human's task is
planned as an ordered list of goals; every goal is delegated to a **subagent**
(a fresh researcher/advisor pair), which either implements it (a *leaf*) or
splits it into subgoals that it delegates in turn (an *orchestrator*). Advisors
approve plans and delegations and verify results; a human approves final
completion.

Both agents run as long-lived, separately sandboxed Docker containers and take
turns through a host-side control plane. Each container serves every session
of the run (one conversation per session), so installed tools persist.

```
                              host
        ┌───────────────────────────────────────────────────────┐
        │  orchestrator (run.mjs)                               │
        │    start containers · budgets · cleanup               │
        ├───────────────────────────────────────────────────────┤
        │  control plane (server.mjs)                           │
        │    protocol engine (sessions, goals) · broker inbox   │
        │    SSE transcript stream · WebUI · control log        │
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

## Protocol

The full specification, with state diagrams and the transition table the
control plane enforces, is in [docs/PROTOCOL.md](docs/PROTOCOL.md). In short:

| Session | Researcher | Advisor |
|---|---|---|
| `skills` (first, optional) | proposes Agent Skills | approves them; the harness installs them for both agents |
| `main` | reviews the plan, delegates each goal, reflects after each one | writes the plan, approves delegations and plan changes |
| `orchestrator` | delegates each subgoal, reflects | approves delegations; final check that the goal is met as a whole |
| `leaf` | implements the goal | verifies the result |

- Every turn ends with exactly one **control tool**; each message from the
  harness says which ones are allowed at that point ("what to do now"), and
  anything else is rejected with a correction prompt.
- Only leaf researchers can change files (bash, write and edit tools).
  Researchers of `main` and `orchestrator` sessions only have read-only file
  tools: they coordinate.
- A leaf has no separate plan step: its goal and the parent's instructions were
  approved one level up, so it works, submits a result (with a report for the
  parent and notes for later agents) and the advisor verifies it. It may ask to
  abort an infeasible goal.
- After every subagent the parent researcher **reflects**: proceed to the next
  goal, change the remaining plan (main session only, the advisor signs off),
  finish, or abort. An orchestrator cannot change its subgoals; it aborts with a
  proposal and its parent re-plans.
- When the main plan is accepted, both main-session contexts are pruned to the
  accepted plan (tool calls and outputs are dropped, reasoning stays).

## Goals

Goals are owned by the control plane, not by a file. Each has an id (unique in
the run; subgoal ids start with their goal's id, e.g. `G2.1`), a title, a
markdown description written for a different agent, acceptance criteria
(observable outcomes, treated as a floor, not as the definition of done), the
relevant skills, and a status (`planned`, `in_progress`, `done`, `aborted`).
When a goal ends it records the subagent's report, notes and the advisor's
verdict. Agents read goals with the `list_goals` / `read_goal` tools and change
them only through control tools; every new subagent gets the notes of the goals
finished before it at the same level.

The run folder keeps readable views: `goals.md` (current tree, regenerated on
every change), `plans/<session>/v<N>.{md,json}` (every plan version) and
`agents/<id>/` (brief, report, notes).

## Subagents

Every goal is delegated with `propose_subagent` (`mode: "full"` or
`"split"` with subgoals, plus instructions and a justification of the scope)
and approved by the advisor with a focus on scope. Subagents run **one at a
time**: the parent is paused until its child finishes, then reflects. Each
subagent starts with a fresh context holding the task, the chain of goals above
it, its goal, the parent's instructions, the approving advisor's conditions and
its siblings' notes. A child runs in the same containers as its parent (same
`/sandbox`, same tools and model) as a separate conversation.

`--max-subagent-depth N` (minimum 1, default unlimited) limits nesting: at the
maximum depth goals must be delegated in full.

## Human-in-the-loop

Only the human ends the run. When the main researcher finishes (or aborts), the
run enters `AWAITING_HUMAN` and the WebUI shows an approval panel with the
summary (or the reason for aborting):

- **Approve** → `DONE` (or `ABORTED` for an abort request)
- **Extend budget** / **Reject** → the main researcher reflects again, with your note

A human can also send a message to either agent of any session at any time; a
message for an agent that is not acting is held and merged into its next
handoff.

## Transcripts & WebUI

Both agents append JSONL transcripts to a host directory mounted outside the
sandbox (`runs/<id>/transcripts/{researcher,advisor}.jsonl`, subagents under
`transcripts/agents/<id>/`). The control plane's own log,
`runs/<id>/control/session.jsonl`, is the source of truth for `--resume` and
`--view`; it is not mounted into any container. The WebUI (`http://127.0.0.1:<port>/?token=...`)
has four panes:

- **Agents** (far left) — the session tree (skills, main, and every subagent,
  tagged `orch` or `leaf` with its goal), with each one's status (acting role,
  waiting on a child, done, aborted). Click a session to switch the other panes
  to its transcript, overview, brief and goals; finished sessions keep their full
  history. Human messages go to the selected session (held until it is working
  again if it is paused).

- **Task / Goals** (left) — the task (main session) or the session's brief,
  outcome and report (subagents), plus the harness's goal tree with live
  statuses; the selected session's goals are highlighted and each goal expands
  to its description, acceptance criteria, verdict, notes and report. Markdown is
  rendered with a standard CommonMark parser (vendored
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
- **Overview** (right) — one clickable item per protocol step (plan proposed or
  accepted, subagent proposed/approved/started/finished, result submitted or
  verified, reflections, completion, human decisions), grouped into sections:
  setup, one per goal (with its live status from the goal tree), and completion.
  The pane header counts goals done.
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
  --build-arg INSTALL_NODE=1 \
  --build-arg INSTALL_PLAYWRIGHT=1 \
  -t research-loop-agent-toolbox:latest .
```

Each arg is an independent opt-in (default `0`); combine the ones you want:

| Build arg | Default | Adds |
|---|---|---|
| `INSTALL_RUST` | `0` | Rust toolchain via rustup (stable, minimal) — `rustc`/`cargo` on PATH, tools under `/opt/rustup` + `/opt/cargo` |
| `INSTALL_UV` | `0` | `uv` (Python toolchain manager) in the agent's home, plus pre-installed CPython 3.11 and 3.12 so `uv venv`/`uv run` don't re-download them |
| `INSTALL_LATEX` | `0` | light TeX Live toolbox: `pdflatex`, common formats/fonts, TikZ/pgf (`texlive-pictures`), and `latexmk` |
| `INSTALL_NODE` | `0` | `nvm` under `/opt/nvm` plus the latest Node.js LTS as default — agent shells get the LTS `node`/`npm` (the harness itself stays on the base Node.js 22); pin nvm with `--build-arg NVM_VERSION=…` |
| `INSTALL_PLAYWRIGHT` | `0` | global `playwright` CLI plus Chromium and its native libraries, baked into `/ms-playwright`; `PLAYWRIGHT_VERSION` is exported so projects can `npm i playwright@$PLAYWRIGHT_VERSION` and reuse the browser |

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
per task (and can even update the bundled Rust/uv/Node.js at runtime).

### Orchestrator flags

| Flag | Default | Description |
|---|---|---|
| `--task` / `--task-file` | — | the broad research task |
| `--initial-sandbox` | — | host folder copied into the researcher sandbox before the session |
| `--researcher-model` / `--advisor-model` | `einfra:qwen3.8-27b` / `einfra:deepseek-v4-flash` | `provider:model` or `provider:model::effort` (see [Reasoning effort](#reasoning-effort)) |
| `--config` | `./pi_config.json` | provider definitions |
| `--image` | `research-loop-agent:latest` | Docker image |
| `--local` | off | run agents as local processes instead of Docker |
| `--docker` | off | force Docker even with `--faux` (test the container path offline) |
| `--faux` | off | offline scripted demo (implies `--local` unless `--docker`) |
| `--auto-approve` | off | auto-approve final completion (for testing) |
| `--skip-skills` | off | skip the skills session and start planning immediately |
| `--max-subagent-depth` | unlimited | maximum subagent nesting depth (minimum 1; at the maximum, goals are delegated in full) |
| `--max-plan-changes` | 0 (unlimited) | approved plan changes allowed in the main session |
| `--max-subagent-rejections` | 0 (unlimited) | rejected delegations per goal before the session ends (main: goes to the human) |
| `--allow-stale-image` | off | run even if the image's agent code differs from this checkout (otherwise the run stops with a rebuild hint) |
| `--no-open` | off | do not open the WebUI in a browser (URL is still printed) |
| `--no-model-discovery` | off | skip querying the provider's `/models` for context/output limits |
| `--researcher-context-window` / `--advisor-context-window` | discovered/config | override a model's context window |
| `--researcher-max-tokens` / `--advisor-max-tokens` | discovered/config | override a model's maximum output tokens |
| `--max-handoffs` | 0 (unlimited) | abort after this many accepted handoffs in the whole run |
| `--wallclock-ms` | 0 | overall wall-clock budget (`0` = disabled) |
| `--max-turns-per-phase` | 1000 | agent turns allowed per phase (`0` = unlimited) |
| `--abort-timeout-ms` | 0 | per-attempt window before an in-flight turn is aborted and retried (`0` = disabled) |
| `--phase-timeout-ms` | 0 | hard per-phase wall clock (`0` = disabled) |
| `--provider-retry-budget` | `8h` | how long to keep retrying one provider/control-plane outage with exponential backoff (`0` = no retries) |
| `--thinking` | medium | reasoning effort for models whose spec has no `::effort` (see [Reasoning effort](#reasoning-effort)) |
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
planning advisor's opening message so it knows what it has. Everything else
(installed tools, generated files) is written on top of this seed. Skills in the
seed's `skills/` folder count as pre-installed: they are copied to the
advisor's sandbox too and listed to the skills session.

## Reasoning effort

**Setting it.** Give each role its own effort in the model spec, e.g.
`--researcher-model psyche:qwen3.8-flash-next-fp8-iq4r::high`. A spec without
`::effort` uses `--thinking` (default `medium`) instead. The levels are
`off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; anything else
stops the run at startup. The orchestrator prints the effective level per role
(`researcher reasoning effort: high (model spec)`), and `run.json` keeps the
specs, so `--resume` uses the same levels.

**What reaches the provider.** The level is handed to pi-ai, which turns it into
request parameters in three steps:

1. **Only for reasoning models.** A model with `"reasoning": false` never gets a
   reasoning parameter, whatever the level. Every custom model in
   `pi_config.json` is marked `"reasoning": true`; catalog models (OpenCode Go)
   carry their own flag.
2. **Clamp to a supported level.** A reasoning model supports `off` through
   `high`, minus any level its `thinkingLevelMap` sets to `null`; `xhigh` and
   `max` only when the map defines them. An unsupported level becomes the next
   *higher* supported one, or else the next lower one.
3. **Map and format.** The clamped level is replaced by the model's
   `thinkingLevelMap` entry, if any, and written in the provider's style. The
   style is the model's `compat.thinkingFormat`, detected from the base URL when
   not configured: OpenRouter URLs use `reasoning: {effort}`, DeepSeek uses
   `thinking: {type}` + `reasoning_effort`, and other OpenAI-compatible servers
   use plain `reasoning_effort`. With `off`, no reasoning option is passed at
   all, so a style only sends something if it has an explicit "off" value.

What the configured models receive (captured from pi-ai's actual request body
with `node scripts/reasoning-params.mjs`):

| Level | custom OpenAI-compatible (`psyche`, `einfra`) | `openrouter-extra` | `opencode-go:deepseek-v4.1-flash` |
|---|---|---|---|
| `off` | *nothing* (the server's default applies; the model may still think) | `reasoning: {effort: "none"}` | `thinking: {type: "disabled"}` |
| `minimal` | `reasoning_effort: "minimal"` | `reasoning: {effort: "minimal"}` | `reasoning_effort: "low"`, `thinking: {type: "enabled"}` |
| `low` | `reasoning_effort: "low"` | `reasoning: {effort: "low"}` | `reasoning_effort: "low"`, thinking enabled |
| `medium` | `reasoning_effort: "medium"` | `reasoning: {effort: "medium"}` | `reasoning_effort: "high"`, thinking enabled |
| `high` | `reasoning_effort: "high"` | `reasoning: {effort: "high"}` | `reasoning_effort: "high"`, thinking enabled |
| `xhigh` | `reasoning_effort: "high"` | `reasoning: {effort: "high"}` | `reasoning_effort: "max"`, thinking enabled |
| `max` | `reasoning_effort: "high"` | `reasoning: {effort: "high"}` | `reasoning_effort: "max"`, thinking enabled |

The OpenCode Go DeepSeek column follows pi-ai's catalog map for the model
(`minimal` and `medium` unsupported, `max` defined). No thinking-token budget
is sent in any of these styles, and the output-token cap is unchanged.

### Per-model settings: `thinkingLevelMap` and `compat`

Both go into a model's entry in `pi_config.json`, next to `"id"` and
`"reasoning"`. They work for custom providers (entries with a `baseUrl`) and for
models added to a built-in provider with `"like"` (which otherwise inherit the
cloned catalog model's values). All custom providers talk the OpenAI
chat-completions API, so these are pi-ai's settings for that API. Check the
effect of any change with `node scripts/reasoning-params.mjs provider:model`.

Example: a self-hosted DeepSeek that should behave like OpenCode Go's (explicit
"thinking disabled" for `off`, `medium` sent as `high`, `max` passed through):

```json
{
  "id": "deepseek-v4.1-flash",
  "reasoning": true,
  "compat": { "thinkingFormat": "deepseek" },
  "thinkingLevelMap": { "minimal": null, "low": "low", "medium": null, "high": "high", "max": "max" }
}
```

#### `thinkingLevelMap`

An object from thinking level (`off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`) to what is sent for it:

| Entry | Effect |
|---|---|
| key missing | the level is supported and sent under its own name (`"medium"`); `xhigh` and `max` are the exception: without a key they are unsupported |
| `"value"` | supported, and `"value"` is sent instead of the level name (e.g. `{"max": "max"}` stops `max` being capped at `high`) |
| `null` | unsupported: a requested level moves to the next *higher* supported level, or else the next lower one |
| `"off": "value"` | sends `"value"` for `off` where the format has a field for it (`openai`: `reasoning_effort`; `openrouter`: `reasoning.effort`, default `"none"`; `string-thinking`: `thinking`, default `"none"`) |
| `"off": null` | sends no explicit "off" (`deepseek` and `openrouter` otherwise send their default disable value) |

The map is applied after clamping, so a level is first moved to a supported one
and then translated.

#### `compat`

An object of overrides. pi-ai first detects every setting from the provider id
and base URL (e.g. `openrouter.ai` → OpenRouter style, `deepseek.com` →
DeepSeek style, anything else → plain OpenAI style); each field you set replaces
only that detected value.

**Reasoning fields:**

| Field | Values | Effect |
|---|---|---|
| `thinkingFormat` | see below | how the level is written into the request |
| `supportsReasoningEffort` | boolean (default `true` except for a few providers, e.g. z.ai, Together, NVIDIA) | `false` omits `reasoning_effort` in the formats that add it (`openai`, `deepseek`, `qwen`, `zai`, `together`, `baseten`); with `openai` nothing is sent at all |
| `chatTemplateKwargs` | object | the `chat_template_kwargs` sent by the `chat-template` format (below) |
| `chatTemplateArgs` | object | the `chat_template_args` sent by the `baseten` format, same syntax |
| `thinkingTokenBudgetField` | `"thinking_token_budget"` (vLLM), `"thinking_budget"` (Qwen/DashScope/SGLang), `"thinking_budget_tokens"` (llama.cpp) | additionally sends a reasoning-token cap under that name: 1024 / 2048 / 8192 / 16384 tokens for `minimal` / `low` / `medium` / `high` (and `xhigh`, `max`), reduced to leave room for the answer. Only sent when the model's `maxTokens` is known. `supportsThinkingTokenBudget: true` is an alias for the vLLM name |
| `requiresReasoningContentOnAssistantMessages` | boolean (detected only for `deepseek.com`) | replays every earlier assistant message with a `reasoning_content` field, as the DeepSeek API requires in tool loops; set it if a DeepSeek-style server complains about `reasoning_content` |
| `requiresThinkingAsText` | boolean | replays earlier reasoning as `<thinking>`-delimited text instead of reasoning fields |

**`thinkingFormat` values** (`effort` = the clamped level after
`thinkingLevelMap`; "on" = any level other than `off`):

| Value | Sends |
|---|---|
| `openai` (default) | `reasoning_effort: effort` when on; nothing for `off` unless `thinkingLevelMap.off` is a string |
| `openrouter` | `reasoning: {effort}`; `off` sends `effort: "none"` |
| `deepseek` | `thinking: {type: "enabled"}` + `reasoning_effort` when on; `thinking: {type: "disabled"}` for `off` |
| `qwen` | `enable_thinking: true` + `reasoning_effort` when on; `enable_thinking: false` for `off` |
| `qwen-chat-template` | `chat_template_kwargs: {enable_thinking, preserve_thinking: true}`: on/off only, the level itself is not sent |
| `chat-template` | `chat_template_kwargs` built from `compat.chatTemplateKwargs` (below); nothing if that is empty |
| `baseten` | `chat_template_args` built from `compat.chatTemplateArgs` + `reasoning_effort` |
| `zai` | `thinking: {type: "enabled" \| "disabled"}` (+ `reasoning_effort` if supported) |
| `together` | `reasoning: {enabled}` + `reasoning_effort` |
| `string-thinking` | `thinking: effort` as a string; `off` sends `"none"` |
| `ant-ling` | `reasoning: {effort}`, only for levels whose `thinkingLevelMap` entry is a string |

**`chatTemplateKwargs` / `chatTemplateArgs`** are objects whose values are
sent as they are, except placeholders `{"$var": ...}`:
`"thinking.enabled"` (`true`/`false`), `"thinking.effort"` (the mapped level)
or `"thinking.budget"` (the token budget above). Add `"omitWhenOff": true` to
leave the key out for `off`. For example:

```json
"compat": {
  "thinkingFormat": "chat-template",
  "chatTemplateKwargs": {
    "enable_thinking": { "$var": "thinking.enabled" },
    "reasoning_effort": { "$var": "thinking.effort", "omitWhenOff": true }
  }
}
```

sends `chat_template_kwargs: {enable_thinking: true, reasoning_effort: "high"}`
for `high`, and `{enable_thinking: false}` for `off`.

**Other `compat` fields** (request-format quirks; the detected values are
usually right):

| Field | Effect |
|---|---|
| `maxTokensField` | `"max_completion_tokens"` or `"max_tokens"` for the output cap |
| `supportsDeveloperRole` | send the system prompt with the `developer` role instead of `system` |
| `supportsStore` | whether the `store` field may be sent |
| `supportsUsageInStreaming` | request token usage in streamed responses (default `true`) |
| `supportsFinishReason` | whether streams report `finish_reason` (if not, pi-ai infers it) |
| `requiresToolResultName` | tool results must carry the tool's `name` |
| `requiresAssistantAfterToolResult` | insert an assistant message between tool results and a following user message |
| `supportsStrictMode` | send `strict` in tool definitions (default `true`) |
| `supportsOpenAIGrammarTools` | allow grammar-constrained custom tools |
| `cacheControlFormat` | `"anthropic"`: add Anthropic-style `cache_control` prompt-caching markers |
| `supportsLongCacheRetention` | allow 24 h / 1 h prompt-cache retention |
| `sendSessionAffinityHeaders`, `sessionAffinityFormat` | send session-affinity headers (`openai`, `openai-nosession` or `openrouter` style) |
| `openRouterRouting`, `vercelGatewayRouting` | provider-routing preferences for those gateways |
| `zaiToolStream`, `deferredToolsMode` | z.ai tool streaming; Kimi deferred-tool serialization |

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

Before planning, the run starts with a short **skills session** (`--skip-skills`
to disable it): an ephemeral researcher/advisor pair whose contexts are
discarded afterwards.

```
SKILLS_PROPOSE → SKILLS_REVIEW → SKILLS_INSTALL (harness) → main session
```

- The researcher searches [skills.sh](https://skills.sh) (`npx skills find`),
  inspects candidates (relevance + security audits), and proposes a set with
  `propose_skills` (or `noneNeeded` with justification).
- The advisor approves or requests changes (`approve_skills` /
  `request_skill_changes`).
- The **harness** installs the approved skills into `/sandbox/skills/<name>/` of
  **both** agents: each agent process runs the `skills` CLI itself, with no model
  involved, and reports what was installed (failures are recorded in
  `runs/<id>/skills.json`; they do not stop the run).
- Skills are listed in every later system prompt, and each goal names the skills
  relevant to it; leaf advisors check that they were used.

Skills in the initial sandbox's `skills/` folder are treated as pre-installed
(copied to the advisor's sandbox and shown to the skills session).

The image ships the `skills` CLI and `DISABLE_TELEMETRY=1`. Skill guidance lives
in `config/researcher/skills/skills-discovery/SKILL.md` and
`config/advisor/skills/reviewing-skills/SKILL.md`.

## Advisor review doctrine

Advisors write the main plan, approve every delegation and plan change, check
orchestrated goals as a whole, and verify every leaf result. They are expected to be
*harsher critics of the high-level solution*, not just goal-checkers: their system
prompt carries an always-on **advisor doctrine** (verify / red-team / explore), and a
leaf advisor judges a result by the intent of the goal's description, with the
acceptance criteria as a floor (criteria that pass while the feature does not work
are not a pass).

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
    control-tools.mjs      # control tools (one per protocol action), by session kind
    goal-tools.mjs         # read-only list_goals / read_goal
    protocol.mjs           # envelopes, kinds, rendering, validation
    model-providers.mjs    # providers, auth, model resolution
    tools.mjs              # bash / read_file (line ranges) / grep / write_file / edit_file / ...
    grep.mjs               # grep tool backend (ripgrep, with a built-in fallback)
    prompts.mjs            # system prompts by role and session kind
    skill-tools.mjs        # harness skill installer (skills CLI)
    transcript.mjs         # JSONL transcript writer
    abort-retry.mjs        # aborted/429/provider-error retry (from pi-retrieve)
    code-hash.mjs          # agent-code fingerprint (stale-image check)
    context-compaction.mjs # length-stop compaction (from pi-retrieve)
    workspace-paths.mjs    # sandbox/config/prefetch/extra-root resolution
    skills.mjs             # skill index loader
    broker-client.mjs      # HTTP long-poll client
    partial-stream.mjs     # live thinking/text streaming to the WebUI
    client-identity.mjs    # provider-required identification (OpenCode headers)
control-plane/
  server.mjs               # HTTP + SSE + static UI
  broker.mjs               # inboxes, control log, run-folder records
  engine.mjs               # protocol engine: sessions, goals, replay (pure)
  state-machine.mjs        # declarative session state machines (docs/PROTOCOL.md)
  goal-store.mjs           # harness-owned goals and plan versions
  harness-text.mjs         # per-state instructions and child briefs
  ui/index.html            # single-file WebUI
orchestrator/
  run.mjs                  # launch, budgets, cleanup, summary
  docker.mjs               # docker run helpers
  credentials.mjs          # host-side credential resolution
config/{researcher,advisor}/
  TOOLS.md                 # role tooling notes
  skills/                  # optional skill packs (SKILL.md + README.md)
Dockerfile.agent           # single image for both roles
docs/PROTOCOL.md           # protocol specification (state machines, goals)
scripts/protocol-doc.mjs   # regenerate the transition table in docs/PROTOCOL.md
scripts/reasoning-params.mjs # show the reasoning parameters sent per model and level
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
fresh, but the sandbox, goals and control log on disk persist, so a run can be
continued:

```bash
node orchestrator/run.mjs --resume runs/<id> \
  --resume-prompt "Re-examine G3; the reviewer disagreed with the permutation design."
```

The control plane replays `runs/<id>/control/session.jsonl` into the exact
sessions, goals and states the run was in (including a subagent that was
working), and the resume prompt goes to the agent expected to act, inside that
session. The prompt warns the agent that its container was rebuilt and its
conversation lost, repeats the current step's instructions, and tells it to
re-orient (system prompt, `list_goals` / `read_goal`, the sandbox) and
*continue*. The prompt also repeats the last message that agent was working on
(e.g. the advisor's required changes), since the conversation holding it is
gone. Other live sessions get a similar note with their next message.

Every launch setting (models, image, local/Docker, resources, thinking,
timeouts, limits, host/port, ...) is saved in `run.json` and restored on
`--resume`/`--view`; flags given again override the saved values. Runs from
before protocol v2 (no `control/` folder) cannot be resumed or viewed with this
version.

Agents must run the agent code of the checkout the orchestrator runs from: each
agent process reports a fingerprint of its code (`agent/` + `package-lock.json`)
when it registers, and a different one (typically an image built before your
latest changes) ends the run immediately with a message telling you to rebuild
the image. `--allow-stale-image` downgrades this to a warning.

To review a finished run without starting containers:

```bash
node orchestrator/run.mjs --view runs/<id>
```

This serves the WebUI with the run's final state (goals, transcripts, statistics)
and no agents, until you interrupt it.

## Reliability hardening

Long sessions are protected against the common derail modes:

- **Provider outages are waited out.** Every provider failure except a context
  overflow (compaction, below) and an abort (5xx, dropped connections, gateway
  errors, HTTP 429, a busy server's "KV pool exhausted", even errors that look
  permanent) trims the failed turn to the last consistent point and retries with
  exponential backoff: 5 s doubling (30 s for
  429, or the provider's `retry-after`), at most 15 min apart, ±20% jitter. Retries
  continue until one outage has lasted `--provider-retry-budget` (default `8h`,
  about 40 attempts; `0` disables), and the budget restarts after any successful
  model turn. pi-ai's own quick retries (`maxRetries`, default 2) run inside each
  attempt. Each wait is noted in the transcript, and the WebUI header shows
  "provider down · retry in …" for that agent. A genuinely permanent error (an
  expired API key) is therefore only noticed by the human watching the run, or
  when the budget runs out; lower `--provider-retry-budget` to fail faster.
- **Context overflow vs. outage**: a "request too large" rejection (including
  gateway wordings such as OpenCode's "too large for the model's configured
  input limit") is first treated as a context overflow: history is compacted
  and the turn retried. If the much smaller request is rejected the same way, it
  was the provider failing, so it is retried with the backoff above instead of
  compacting again.
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
- **Control-plane outages are waited out too**: if an agent cannot reach the
  control plane (host asleep, offline, restarting), polls, handoffs and
  registration are retried with backoff (3 s doubling, at most 1 min apart) for
  the same retry budget, then the agent exits. A handoff resent after a lost
  response is harmless: the duplicate is refused as out of turn.
- **Clean termination**: SIGTERM/SIGINT aborts and exits, so containers/processes
  are not orphaned.
- **Exactly one control tool per turn**: a second call is refused; the first
  handoff stands.
- **Illegal handoffs recover**: the broker rejects, queues a state-aware
  correction prompt, and the agent continues (it never crashes on the rejection).
- **Human notes never start a phase.** A note for the role that is currently
  working is injected into its running conversation after the current model
  turn (agents poll their inbox concurrently with the work); a note for any
  other role or agent is held and merged into its next handoff. Either way a
  note cannot make an agent act out of turn.
- **Out-of-turn handoffs are refused quietly**: if an agent hands off when it
  is not its turn, the broker discards it without sending a correction prompt
  (which would only start another out-of-turn phase), and the agent waits for
  its next message. Such refusals do not count toward the rejection cap.
- **`--max-handoffs`** counts researcher goal steps, not every message.

## Notes & limitations

- Containers are ephemeral: a crash loses runtime installs (a restart is a fresh
  container). During a normal session the container is never restarted.
- The advisor's view of the researcher's workspace is read-only and point-in-time
  at handoff; the sequence guarantees the researcher is idle while the advisor
  inspects.
- The control plane is a single local process; run one session per orchestrator
  invocation.
