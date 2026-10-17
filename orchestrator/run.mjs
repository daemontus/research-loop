#!/usr/bin/env node
/**
 * research-loop orchestrator.
 *
 * Creates a run directory, starts the control plane, launches the two agent
 * containers (or local processes with --local), and waits for the human to
 * approve final completion (or for a budget to be exceeded).
 *
 * Usage:
 *   node orchestrator/run.mjs --task "Design a parallel Apply algorithm for BDDs" \
 *     --researcher-model einfra:qwen3.8-27b --advisor-model einfra:deepseek-v4-flash
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startControlPlane } from "../control-plane/server.mjs";
import {
  expectedRoleForState,
  replaySessionLog,
} from "../control-plane/broker.mjs";
import { STATES } from "../control-plane/state-machine.mjs";
import {
  discoverModelLimits,
  providerForDocker,
  resolveCredentials,
} from "./credentials.mjs";
import { dockerBridgeGateway, imageExists, runContainer, stopContainer } from "./docker.mjs";
import { buildRunStats, renderStatsSummary } from "./stats.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || /^127\./.test(host);
}

function parseArgs(argv) {
  const args = {
    task: "",
    taskSet: false,
    taskFile: null,
    initialSandbox: null,
    researcherModel: "einfra:qwen3.8-27b",
    researcherModelSet: false,
    advisorModel: "einfra:deepseek-v4-flash",
    advisorModelSet: false,
    config: path.join(REPO_ROOT, "pi_config.json"),
    image: "research-loop-agent:latest",
    runDir: null,
    resume: null,
    resumePrompt: null,
    view: null,
    host: "127.0.0.1",
    port: 0,
    maxHandoffs: 0,
    wallclockMs: 0,
    maxTurnsPerPhase: 1000,
    abortTimeoutMs: 0,
    phaseTimeoutMs: 0,
    thinking: "medium",
    local: false,
    platform: null,
    cpu: null,
    memory: null,
    printJobs: false,
    faux: false,
    autoApprove: false,
    docker: false,
    open: true,
    discoverModels: true,
    skipSkills: false,
    // null = unlimited nesting; 0 disables subagents.
    maxSubagentDepth: null,
    maxSubagentDepthSet: false,
    // How long agents ride out a provider/control-plane outage (backoff).
    retryBudgetMs: 8 * 3600e3,
    // How strongly the main researcher is steered towards delegating goals.
    delegation: "optional",
    delegationSet: false,
    researcherContextWindow: null,
    advisorContextWindow: null,
    researcherMaxTokens: null,
    advisorMaxTokens: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "--task": args.task = next(); args.taskSet = true; break;
      case "--task-file": args.taskFile = next(); break;
      case "--initial-sandbox": args.initialSandbox = next(); break;
      case "--researcher-model": args.researcherModel = next(); args.researcherModelSet = true; break;
      case "--advisor-model": args.advisorModel = next(); args.advisorModelSet = true; break;
      case "--config": args.config = next(); break;
      case "--image": args.image = next(); break;
      case "--run-dir": args.runDir = next(); break;
      case "--resume": args.resume = next(); break;
      case "--resume-prompt": args.resumePrompt = next(); break;
      case "--view": args.view = next(); break;
      case "--host": args.host = next(); break;
      case "--port": args.port = Number(next()); break;
      case "--max-handoffs": args.maxHandoffs = Number(next()); break;
      case "--wallclock-ms": args.wallclockMs = Number(next()); break;
      case "--max-turns-per-phase": args.maxTurnsPerPhase = Number(next()); break;
      case "--abort-timeout-ms": args.abortTimeoutMs = Number(next()); break;
      case "--phase-timeout-ms": args.phaseTimeoutMs = Number(next()); break;
      case "--thinking": args.thinking = next(); break;
      case "--platform": args.platform = next(); break;
      case "--cpu": args.cpu = Number(next()); break;
      case "--memory": args.memory = next(); break;
      case "--local": args.local = true; break;
      case "--docker": args.docker = true; break;
      case "--faux": args.faux = true; break;
      case "--auto-approve": args.autoApprove = true; break;
      case "--no-open": args.open = false; break;
      case "--no-model-discovery": args.discoverModels = false; break;
      case "--skip-skills": args.skipSkills = true; args.skipSkillsSet = true; break;
      case "--provider-retry-budget": args.retryBudgetMs = parseDuration(next(), a); break;
      case "--delegation": {
        args.delegation = next();
        args.delegationSet = true;
        if (!["optional", "encouraged"].includes(args.delegation)) {
          throw new Error(`--delegation must be 'optional' or 'encouraged', got ${args.delegation}`);
        }
        break;
      }
      case "--max-subagent-depth": {
        const v = next();
        args.maxSubagentDepth = v === "unlimited" ? null : Number(v);
        args.maxSubagentDepthSet = true;
        if (args.maxSubagentDepth !== null && !(Number.isInteger(args.maxSubagentDepth) && args.maxSubagentDepth >= 0)) {
          throw new Error(`--max-subagent-depth must be a non-negative integer or 'unlimited', got ${v}`);
        }
        break;
      }
      case "--researcher-context-window": args.researcherContextWindow = Number(next()); break;
      case "--advisor-context-window": args.advisorContextWindow = Number(next()); break;
      case "--researcher-max-tokens": args.researcherMaxTokens = Number(next()); break;
      case "--advisor-max-tokens": args.advisorMaxTokens = Number(next()); break;
      case "--print-jobs": args.printJobs = true; break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: node orchestrator/run.mjs --task <text> [options]",
            "  --researcher-model p:m   --advisor-model p:m",
            "  --initial-sandbox <dir>  --config <pi_config.json>",
            "  --local | --docker | --faux",
            "  --no-open  --no-model-discovery  --skip-skills",
            "  --max-subagent-depth N   limit subagent nesting (0 = no subagents; default unlimited)",
            "  --provider-retry-budget D  keep retrying a provider/control-plane outage with",
            "                exponential backoff for this long (e.g. 8h, 30m; 0 = no retries; default 8h)",
            "  --delegation optional|encouraged  steer the main researcher towards delegating",
            "                goals to subagents (supervisor mode); default optional",
            "  --researcher-context-window N  --advisor-context-window N",
            "  --researcher-max-tokens N      --advisor-max-tokens N",
            "  --max-handoffs N  --wallclock-ms N  --max-turns-per-phase N",
            "    (--max-handoffs caps researcher goal steps: proposals + results; 0 = unlimited)",
            "  --host <ip>  --port <n>  (WebUI bind address/port; defaults 127.0.0.1 / random)",
            "  --abort-timeout-ms N  --phase-timeout-ms N  (0 = disabled; default 0)",
            "  --resume <run-id|dir>    continue an interrupted session (fresh containers,",
            "                sandbox/GOALS.md/transcripts preserved)",
            "  --resume-prompt <text>   instructions injected when resuming a session",
            "  --view <run-id|dir>      open the WebUI for a finished run without agents",
            "Timeouts are disabled by default so long runs continue; set any to a",
            "positive value (ms) to enable, and monitor progress in the WebUI.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  if (!args.task && args.taskFile) {
    args.task = fs.readFileSync(args.taskFile, "utf8");
    args.taskSet = true;
  }
  if (!args.task.trim() && !args.view && !args.resume) {
    console.error("missing --task (or --task-file)");
    process.exit(2);
  }
  return args;
}

/** "8h" / "30m" / "45s" / "1500ms" / "0" -> milliseconds. */
function parseDuration(value, flag) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m || (!m[2] && Number(m[1]) !== 0)) {
    throw new Error(`${flag} expects a duration such as 8h, 30m, 45s or 0, got ${value}`);
  }
  const factor = { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] || "ms"];
  return Math.round(Number(m[1]) * factor);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

/** Resolve a --resume/--view argument into a run directory. */
function resolveRunArg(arg) {
  const raw = String(arg || "");
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (raw.includes("/") || raw.startsWith(".")) return path.resolve(raw);
  return path.resolve(REPO_ROOT, "runs", raw);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The `start` entry of a run's session log (task, skipSkills), if any. */
function readSessionStart(runDir) {
  try {
    const lines = fs.readFileSync(path.join(runDir, "transcripts", "session.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes('"start"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === "start") return e;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // no session log
  }
  return {};
}

/**
 * Read metadata of a previous orchestrator run. `session.json` is only written
 * on a clean exit, so fall back to `run.json` (written at startup) and finally
 * to the `start` entry of the session log.
 */
function readRunMeta(runDir) {
  const meta = readJsonFile(path.join(runDir, "session.json"));
  const run = readJsonFile(path.join(runDir, "run.json"));
  const start = readSessionStart(runDir);
  return {
    sessionId: meta.sessionId || run.sessionId || path.basename(runDir),
    task: meta.task || run.task || start.task || "",
    researcherModel: meta.researcherModel || run.researcherModel || null,
    advisorModel: meta.advisorModel || run.advisorModel || null,
    skipSkills: Boolean(meta.skipSkills ?? run.skipSkills ?? start.skipSkills),
    maxSubagentDepth: run.maxSubagentDepth ?? meta.maxSubagentDepth ?? null,
    delegation: run.delegation || meta.delegation || null,
    label: meta.label || run.label || "",
    state: meta.state || null,
    uiUrl: meta.uiUrl || "",
  };
}

/** Address local agent processes use to reach the control plane. */
function localConnectHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host;
}

let fauxCallSeq = 0;
/** One scripted assistant message; `files` are written (write_file) before the tool call. */
function fauxStep(text, toolName, payload, files = {}) {
  return {
    content: [
      { type: "text", text },
      ...Object.entries(files).map(([p, content]) => ({
        type: "toolCall",
        id: `call-${++fauxCallSeq}`,
        name: "write_file",
        arguments: { path: p, content },
      })),
      { type: "toolCall", id: `call-${++fauxCallSeq}`, name: toolName, arguments: payload },
    ],
    stopReason: "toolUse",
  };
}

/** Scripted offline scenario for --faux (no API keys, no model needed). */
function fauxScenario() {
  return {
    researcher: {
      provider: "faux",
      responses: [
        fauxStep("No reusable skill is needed for this demo.", "propose_skills", {
          summary: "none needed",
          noneNeeded: true,
          skills: [],
        }),
        fauxStep("No skills to install.", "confirm_skills_installed", { installed: [] }),
        fauxStep(
          "Decomposed task; proposing G1.",
          "submit_plan",
          {
            goalId: "G1",
            title: "Survey the problem",
            plan: ["Delegate a background survey to a subagent", "Write notes"],
            acceptanceCriteria: ["notes.md exists", "summarizes the problem"],
            execution: "subagent",
            executionRationale: "The survey is self-contained.",
          },
          { "GOALS.md": "# Research task\nDemo\n\n## Goals\n### G1 — Survey the problem [status: in_progress]\n### G2 — Draft an approach [status: proposed]\n" },
        ),
        fauxStep("Delegating the background survey.", "propose_subagent", {
          title: "Background survey",
          goalId: "G1",
          instructions: "Survey background for the task and summarize it in agents/S1/survey.md.",
          rationale: "Self-contained; benefits from a clean context.",
          expectedOutputs: ["agents/S1/survey.md"],
        }),
        // --- subagent S1 (its own conversation in this same process) ---
        fauxStep(
          "Subagent: planning the survey.",
          "submit_plan",
          {
            goalId: "G1",
            title: "Write the survey",
            plan: ["Write survey.md"],
            acceptanceCriteria: ["agents/S1/survey.md exists"],
          },
          { "agents/S1/GOALS.md": "# Research task\nBackground survey\n\n## Goals\n### G1 — Write the survey [status: in_progress]\n" },
        ),
        fauxStep(
          "Subagent: survey written.",
          "submit_result",
          {
            goalId: "G1",
            summary: "Wrote agents/S1/survey.md.",
            artifacts: ["agents/S1/survey.md"],
            verification: ["cat agents/S1/survey.md"],
            status: "complete",
          },
          { "agents/S1/survey.md": "# Survey\nBackground notes.\n" },
        ),
        fauxStep(
          "Subagent: done.",
          "request_task_completion",
          { summary: "Survey done.", deliverables: ["agents/S1/survey.md"] },
          { "agents/S1/REPORT.md": "# Report\nWrote the background survey to agents/S1/survey.md.\n" },
        ),
        // --- back in the main session ---
        fauxStep("G1 complete.", "submit_result", {
          goalId: "G1",
          summary: "Wrote notes.md.",
          artifacts: ["notes.md"],
          verification: ["cat notes.md"],
          status: "complete",
        }),
        fauxStep("Proposing G2.", "submit_plan", {
          goalId: "G2",
          title: "Draft an approach",
          plan: ["Draft design", "Add a small prototype"],
          acceptanceCriteria: ["design.md exists"],
        }),
        fauxStep("G2 complete.", "submit_result", {
          goalId: "G2",
          summary: "Wrote design.md.",
          artifacts: ["design.md"],
          verification: ["cat design.md"],
          status: "complete",
        }),
        fauxStep("All goals complete.", "request_task_completion", {
          summary: "Task done.",
          deliverables: ["notes.md", "design.md"],
        }),
      ],
    },
    advisor: {
      provider: "faux",
      responses: [
        fauxStep("No skills needed.", "approve_skills", { feedback: "ok" }),
        fauxStep("Plan is sound.", "approve_plan", { goalId: "G1", feedback: "go" }),
        fauxStep("Well scoped.", "approve_subagent", { feedback: "go", conditions: ["keep it short"] }),
        // --- subagent S1 ---
        fauxStep("Plan is sound.", "approve_plan", { goalId: "G1", feedback: "go" }),
        fauxStep("Verified survey.md.", "accept_result", {
          goalId: "G1",
          feedback: "goal met",
          verification: ["read survey.md"],
        }),
        fauxStep("Report is accurate.", "accept_task_completion", { summary: "Survey verified.", feedback: "ok" }),
        // --- back in the main session ---
        fauxStep("Verified notes.md.", "accept_result", {
          goalId: "G1",
          feedback: "goal met",
          verification: ["read notes.md"],
        }),
        fauxStep("Plan is sound.", "approve_plan", { goalId: "G2", feedback: "go" }),
        fauxStep("Verified design.md.", "accept_result", {
          goalId: "G2",
          feedback: "goal met",
          verification: ["read design.md"],
        }),
        fauxStep("Task looks complete.", "accept_task_completion", {
          summary: "All goals verified.",
          feedback: "ok",
        }),
      ],
    },
  };
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // No browser/opener available; the URL is printed for manual use.
    });
    child.unref();
  } catch {
    // ignore
  }
}

/**
 * --view: prefer the root state recorded in session.json (it has the final
 * terminal reason), falling back to the replayed one.
 */
function replayedRootState(recorded, replayed) {
  return {
    ...replayed,
    state: recorded.state,
    terminalReason: recorded.terminalReason ?? replayed.terminalReason,
    finishedAt: recorded.finishedAt ?? replayed.finishedAt,
    startedAt: recorded.startedAt ?? replayed.startedAt,
    humanDecisions: recorded.humanDecisions ?? replayed.humanDecisions,
  };
}

function modelIdOnly(spec) {
  const raw = String(spec || "");
  const sep = raw.indexOf(":");
  const rest = sep === -1 ? raw : raw.slice(sep + 1);
  const effortSep = rest.lastIndexOf("::");
  return effortSep === -1 ? rest : rest.slice(0, effortSep);
}

/**
 * Compose the prompt an agent receives when a session is resumed. Stresses that
 * the container is fresh and the environment must be rebuilt from the sandbox.
 */
function buildResumePrompt({ task, initialState, expected, goal, resumePrompt, agentId = "root" }) {
  const sub = agentId && agentId !== "root";
  return [
    "This session is being RESUMED after an interruption.",
    "",
    "## Environment has been recreated",
    "You are running in a FRESH container. Everything you installed in the previous session",
    "(packages, tools, skills) is GONE. Everything committed to disk in the sandbox is",
    "preserved: GOALS.md, source code, notes, and results. First inspect /sandbox to find out",
    "where things stand, then (re)install whatever you need, then CONTINUE the task — do not",
    "restart it from the beginning.",
    "",
    "## Where we left off",
    ...(sub
      ? [
          `The interruption happened while subagent ${agentId} was running; you are that subagent's`,
          `${expected || "agent"}. Your subtask instructions are in your system prompt; your goals file is`,
          `${expected === "advisor" ? "/researcher-sandbox" : "/sandbox"}/agents/${agentId}/GOALS.md.`,
        ]
      : []),
    `The previous session was interrupted in state ${initialState}${goal ? ` on goal ${goal}` : ""}.`,
    expected
      ? `You (${expected}) were expected to act next; carry on with that responsibility.`
      : "Control returns to the human; the session awaits a decision.",
    ...(resumePrompt ? ["", "## Extra instructions from the human", resumePrompt] : []),
    "",
    `## ${sub ? "Overall research task (context)" : "Broad research task"}`,
    task,
  ].join("\n");
}

/** Merge contextWindow/maxTokens into the provider's model entry. */
function applyModelLimits(provider, modelSpec, limits) {
  const id = modelIdOnly(modelSpec);
  const models = Array.isArray(provider.models) ? provider.models.map((m) => ({ ...m })) : [];
  let index = models.findIndex((m) => m && m.id === id);
  if (index === -1) {
    models.push({ id });
    index = models.length - 1;
  }
  if (Number(limits.contextWindow) > 0) models[index].contextWindow = Number(limits.contextWindow);
  if (Number(limits.maxTokens) > 0) models[index].maxTokens = Number(limits.maxTokens);
  return { ...provider, models };
}

/**
 * Resolve the provider for one role, filling in context/output limits from
 * (lowest to highest priority): discovery, pi_config.json, CLI flags.
 */
async function resolveRoleProvider(creds, modelSpec, { contextWindow, maxTokens, discover }) {
  let provider = creds.provider;
  if (!provider) {
    // Built-in catalog model: its limits come from the catalog; CLI overrides
    // are applied by the agent (job.modelLimits).
    const modelLimits = {};
    if (Number(contextWindow) > 0) modelLimits.contextWindow = Number(contextWindow);
    if (Number(maxTokens) > 0) modelLimits.maxTokens = Number(maxTokens);
    const overridden = Object.keys(modelLimits).length > 0;
    return {
      provider: null,
      modelLimits: overridden ? modelLimits : null,
      note: overridden
        ? `override contextWindow=${contextWindow ?? "?"} maxTokens=${maxTokens ?? "?"}`
        : null,
    };
  }

  const before = (provider.models || []).find((m) => m && m.id === modelIdOnly(modelSpec)) || {};
  let note = null;

  if (discover) {
    const found = await discoverModelLimits(provider, modelIdOnly(modelSpec), creds.apiKey);
    if (found.contextWindow || found.maxTokens) {
      provider = applyModelLimits(provider, modelSpec, {
        contextWindow: before.contextWindow || found.contextWindow,
        maxTokens: before.maxTokens || found.maxTokens,
      });
      note =
        `discovered contextWindow=${found.contextWindow ?? "?"} ` +
        `maxTokens=${found.maxTokens ?? "?"}`;
    } else {
      note = "discovery returned no limits";
    }
  }

  if (Number(contextWindow) > 0 || Number(maxTokens) > 0) {
    provider = applyModelLimits(provider, modelSpec, { contextWindow, maxTokens });
    note = `${note ? `${note}; ` : ""}override contextWindow=${contextWindow ?? "?"} maxTokens=${maxTokens ?? "?"}`;
  }

  return { provider, note };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orchestratorStartedAt = Date.now();

  // Resolve the target run directory: a brand-new session, a resumed one, or a
  // read-only view.
  let resumed = false;
  let viewing = false;
  let runMeta = null;
  let runDir;
  if (args.view) {
    viewing = true;
    runDir = resolveRunArg(args.view);
  } else if (args.resume) {
    resumed = true;
    runDir = resolveRunArg(args.resume);
  } else {
    runDir = path.resolve(args.runDir || path.join(REPO_ROOT, "runs", timestampId()));
  }
  if (
    (resumed || viewing) &&
    (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory())
  ) {
    throw new Error(`run directory not found: ${runDir}`);
  }
  if (resumed || viewing) {
    runMeta = readRunMeta(runDir);
    if (!args.taskSet) args.task = runMeta.task || "";
    if (!args.researcherModelSet && runMeta.researcherModel) {
      args.researcherModel = runMeta.researcherModel;
    }
    if (!args.advisorModelSet && runMeta.advisorModel) {
      args.advisorModel = runMeta.advisorModel;
    }
    if (!args.skipSkillsSet && runMeta.skipSkills) args.skipSkills = true;
    if (!args.maxSubagentDepthSet) args.maxSubagentDepth = runMeta.maxSubagentDepth ?? null;
    if (!args.delegationSet && runMeta.delegation) args.delegation = runMeta.delegation;
    if ((resumed && !runMeta.researcherModel) || (resumed && !runMeta.advisorModel)) {
      console.warn(
        "[research-loop] warning: models of the original run are unknown; using " +
          `${args.researcherModel} / ${args.advisorModel} (override with --researcher-model/--advisor-model)`,
      );
    }
  }
  if (!args.task.trim()) {
    throw new Error(
      "no task available for this run; pass --task (or --task-file) to provide one",
    );
  }
  // Short run name for the WebUI tab title/header, to tell parallel runs apart:
  // the task file's name, else the original run's label, else the run dir.
  const label = args.taskFile
    ? path.basename(args.taskFile, path.extname(args.taskFile))
    : runMeta?.label || path.basename(runDir);
  if (viewing && runMeta.state && !["DONE", "ABORTED"].includes(runMeta.state.state)) {
    console.warn(`[research-loop] note: session was ${runMeta.state.state}, not finished; showing its current state.`);
  }

  const sessionId = (resumed || viewing) && runMeta?.sessionId ? runMeta.sessionId : timestampId();
  const transcriptDir = path.join(runDir, "transcripts");
  const researcherSandbox = path.join(runDir, "researcher-sandbox");
  const advisorSandbox = path.join(runDir, "advisor-sandbox");
  for (const d of [runDir, transcriptDir, researcherSandbox, advisorSandbox]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Optionally seed the researcher sandbox with host-provided resources.
  // Skipped for resumed/viewed runs: the sandbox already holds prior state.
  let initialNote = "";
  if (args.initialSandbox && !resumed && !viewing) {
    const src = path.resolve(args.initialSandbox);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new Error(`--initial-sandbox is not a directory: ${src}`);
    }
    fs.cpSync(src, researcherSandbox, { recursive: true, force: true });
    const entries = fs.readdirSync(researcherSandbox).sort();
    initialNote = `Provided resources copied into /sandbox: ${entries.join(", ")}.`;
    console.log(`[research-loop] seeded researcher sandbox from ${src} (${entries.length} entries)`);
  }

  const token = randomBytes(24).toString("hex");
  const goalsPath = path.join(researcherSandbox, "GOALS.md");
  // Subagent records (instructions, metadata, GOALS snapshot, final report).
  const agentsDir = path.join(runDir, "agents");

  const configPath = path.isAbsolute(args.config) ? args.config : path.resolve(args.config);

  // ---- View-only mode: replay history + final state, no agents/containers. ----
  if (viewing) {
    const control = await startControlPlane({
      token,
      task: args.task,
      label,
      transcriptDir,
      sessionId,
      goalsPath,
      host: args.host,
      port: args.port,
      maxHandoffs: args.maxHandoffs,
      initialNote,
      skipSkills: args.skipSkills,
      installedSkillsPath: path.join(researcherSandbox, "skills"),
      researcherSandbox,
      agentsDir,
      viewOnly: true,
      ...(() => {
        const replayed = replaySessionLog(transcriptDir, { agentsDir });
        return {
          seedState: runMeta?.state?.state ? replayedRootState(runMeta.state, replayed.state) : replayed.state,
          seedAgents: replayed.agents,
          seedActiveId: replayed.activeId,
        };
      })(),
    });
    console.log(`[research-loop] viewing session ${sessionId}`);
    console.log(`[research-loop] UI: ${control.url}`);
    if (args.open) openBrowser(control.url);
    console.log("[research-loop] press Ctrl-C to exit");
    await new Promise(() => {});
    return;
  }

  let researcherCreds;
  let advisorCreds;
  let fauxResearcher = null;
  let fauxAdvisor = null;
  if (args.faux) {
    args.local = !args.docker;
    args.researcherModel = "faux:faux-1";
    args.advisorModel = "faux:faux-1";
    const scenario = fauxScenario();
    fauxResearcher = scenario.researcher;
    fauxAdvisor = scenario.advisor;
    researcherCreds = { provider: null, apiKey: null };
    advisorCreds = { provider: null, apiKey: null };
  } else {
    researcherCreds = await resolveCredentials(args.researcherModel, configPath);
    advisorCreds = await resolveCredentials(args.advisorModel, configPath);
    if (!researcherCreds || researcherCreds.error) {
      throw new Error(
        `Cannot use researcher model ${args.researcherModel}: ` +
          (researcherCreds?.error || "check pi_config.json and env/auth.json."),
      );
    }
    if (!advisorCreds || advisorCreds.error) {
      throw new Error(
        `Cannot use advisor model ${args.advisorModel}: ` +
          (advisorCreds?.error || "check pi_config.json and env/auth.json."),
      );
    }
  }

  // Resolve per-model context/output limits (discovery + config + CLI flags).
  const researcherLimits = await resolveRoleProvider(researcherCreds, args.researcherModel, {
    contextWindow: args.researcherContextWindow,
    maxTokens: args.researcherMaxTokens,
    discover: args.discoverModels,
  });
  const advisorLimits = await resolveRoleProvider(advisorCreds, args.advisorModel, {
    contextWindow: args.advisorContextWindow,
    maxTokens: args.advisorMaxTokens,
    discover: args.discoverModels,
  });
  if (researcherLimits.note) {
    console.log(`[research-loop] researcher (${args.researcherModel}): ${researcherLimits.note}`);
  }
  if (advisorLimits.note) {
    console.log(`[research-loop] advisor (${args.advisorModel}): ${advisorLimits.note}`);
  }

  // When resuming, restore the control-plane state from the on-disk session
  // log so the machines pick up where the previous process left off.
  let replay = null;
  if (resumed) {
    replay = replaySessionLog(transcriptDir, { agentsDir });
    if (!replay.started) {
      throw new Error(
        `cannot resume ${runDir}: no usable session log found; start a new run instead`,
      );
    }
    if (replay.state.state === STATES.DONE) {
      throw new Error(`session ${sessionId} already completed; use --view to review it`);
    }
  }

  // Persist the run's settings up front so a crashed run can still be resumed
  // with the same task/models (session.json is only written on a clean exit).
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(
      {
        sessionId,
        label,
        task: args.task,
        researcherModel: args.researcherModel,
        advisorModel: args.advisorModel,
        skipSkills: args.skipSkills,
        maxSubagentDepth: args.maxSubagentDepth,
        delegation: args.delegation,
      },
      null,
      2,
    ),
  );

  const control = await startControlPlane({
    token,
    task: args.task,
    label,
    transcriptDir,
    sessionId,
    goalsPath,
    host: args.host,
    port: args.port,
    maxHandoffs: args.maxHandoffs,
    initialNote,
    skipSkills: args.skipSkills,
    installedSkillsPath: path.join(researcherSandbox, "skills"),
    viewOnly: resumed,
    initialState: replay?.state || null,
    initialResearcherSteps: replay?.researcherSteps || 0,
    initialAgents: replay?.agents || null,
    initialActiveId: replay?.activeId || null,
    initialRootPendingProposal: replay?.rootPendingProposal || null,
    initialRootLastPlanExecution: replay?.rootLastPlanExecution || null,
    researcherSandbox,
    agentsDir,
    maxSubagentDepth: args.maxSubagentDepth,
    delegation: args.delegation,
  });
  console.log(`[research-loop] session ${sessionId}${resumed ? " (resumed)" : ""}`);
  console.log(`[research-loop] UI: ${control.url}`);

  if (resumed) {
    const activeId = replay.activeId || "root";
    const active = activeId === "root" ? { state: replay.state } : replay.agents.find((a) => a.id === activeId);
    const expected = expectedRoleForState(active.state.state);
    const goal = active.state.currentGoalId;
    const resumeText = buildResumePrompt({
      task: args.task,
      initialState: active.state.state,
      expected,
      goal,
      resumePrompt: args.resumePrompt,
      skipSkills: args.skipSkills,
      agentId: activeId,
    });
    control.broker.resume(resumeText);
    console.log(
      `[research-loop] resumed in state ${active.state.state}` +
        `${activeId !== "root" ? ` (subagent ${activeId})` : ""} (${expected || "awaiting human"})`,
    );
  }

  // Ctrl-C / termination should abort the session and let the cleanup path
  // below stop the containers, instead of leaking them.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[research-loop] interruption received; shutting down…");
    if (!control.broker.isClosed()) control.broker.abort("interrupted by user");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const commonJob = {
    sessionId,
    token,
    task: args.task,
    thinkingLevel: args.thinking,
    maxTurnsPerPhase: args.maxTurnsPerPhase,
    abortTimeoutMs: args.abortTimeoutMs,
    phaseTimeoutMs: args.phaseTimeoutMs,
    skipSkills: args.skipSkills,
    maxSubagentDepth: args.maxSubagentDepth,
    delegation: args.delegation,
    retryBudgetMs: args.retryBudgetMs,
  };

  const localBrokerUrl = `http://${localConnectHost(args.host)}:${control.port}`;

  const jobs = {
    researcher: {
      ...commonJob,
      role: "researcher",
      model: args.researcherModel,
      brokerUrl: args.local ? localBrokerUrl : "http://host.docker.internal:8088",
      sandbox: args.local ? researcherSandbox : "/sandbox",
      configDir: args.local ? path.join(REPO_ROOT, "config", "researcher") : "/config",
      transcriptPath: args.local
        ? path.join(transcriptDir, "researcher.jsonl")
        : "/transcripts/researcher.jsonl",
      provider: researcherLimits.provider,
      modelLimits: researcherLimits.modelLimits || undefined,
      extraModels: researcherCreds?.extraModel ? [researcherCreds.extraModel] : undefined,
      apiKey: researcherCreds?.apiKey ?? null,
      faux: fauxResearcher || undefined,
    },
    advisor: {
      ...commonJob,
      role: "advisor",
      model: args.advisorModel,
      brokerUrl: args.local ? localBrokerUrl : "http://host.docker.internal:8088",
      sandbox: args.local ? advisorSandbox : "/sandbox",
      configDir: args.local ? path.join(REPO_ROOT, "config", "advisor") : "/config",
      transcriptPath: args.local
        ? path.join(transcriptDir, "advisor.jsonl")
        : "/transcripts/advisor.jsonl",
      provider: advisorLimits.provider,
      modelLimits: advisorLimits.modelLimits || undefined,
      extraModels: advisorCreds?.extraModel ? [advisorCreds.extraModel] : undefined,
      apiKey: advisorCreds?.apiKey ?? null,
      faux: fauxAdvisor || undefined,
      extraRoots: [
        {
          prefix: "/researcher-sandbox",
          dir: args.local ? researcherSandbox : "/researcher-sandbox",
        },
      ],
    },
  };

  // In docker mode the broker URL uses a fixed in-container port; bind the
  // control plane to that port on the host side is not possible with a random
  // port, so we rewrite to the actual port but keep host.docker.internal.
  if (!args.local) {
    for (const job of Object.values(jobs)) {
      job.brokerUrl = `http://host.docker.internal:${control.port}`;
      if (job.provider) job.provider = providerForDocker(job.provider);
    }
  }

  if (args.printJobs) {
    // Final jobs as the agents receive them, minus secrets.
    const redact = (k, v) => ((k === "apiKey" || k === "token") && v ? "<redacted>" : v);
    console.log(JSON.stringify(jobs, redact, 2));
    control.close();
    return;
  }

  if (args.open) openBrowser(control.url);

  if (!args.local) {
    if (!imageExists(args.image)) {
      throw new Error(
        `Docker image ${args.image} not found. Build it with: docker build -f Dockerfile.agent -t ${args.image} .`,
      );
    }
    // On Linux, host.docker.internal is the bridge gateway, which cannot reach
    // a loopback-bound server; additionally listen on the gateway address.
    if (process.platform === "linux" && isLoopbackHost(args.host)) {
      const gateway = dockerBridgeGateway();
      try {
        if (!gateway) throw new Error("could not determine the docker bridge gateway");
        await control.listenAlso(gateway);
        console.log(`[research-loop] control plane also listening on ${gateway}:${control.port} (docker bridge)`);
      } catch (e) {
        console.error(
          `[research-loop] warning: containers may not reach the control plane (${e?.message || e}); ` +
            "pass --host 0.0.0.0 (or the docker bridge IP) if agents fail to register",
        );
      }
    }
  }

  const children = {};
  if (args.local) {
    for (const role of ["researcher", "advisor"]) {
      const env = { ...process.env, RESEARCH_LOOP_JOB: JSON.stringify(jobs[role]) };
      const child = spawn(process.execPath, [path.join(REPO_ROOT, "agent", "main.mjs")], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const logFile = path.join(runDir, "logs", `${role}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const stream = fs.createWriteStream(logFile, { flags: "a" });
      child.stdout.pipe(stream);
      child.stderr.pipe(stream);
      children[role] = { child, name: `${role}-local` };
    }
  } else {
    const mounts = {
      researcher: [
        { source: researcherSandbox, target: "/sandbox" },
        { source: transcriptDir, target: "/transcripts" },
        { source: path.join(REPO_ROOT, "config", "researcher"), target: "/config", ro: true },
      ],
      advisor: [
        { source: advisorSandbox, target: "/sandbox" },
        { source: researcherSandbox, target: "/researcher-sandbox", ro: true },
        { source: transcriptDir, target: "/transcripts" },
        { source: path.join(REPO_ROOT, "config", "advisor"), target: "/config", ro: true },
      ],
    };
    for (const role of ["researcher", "advisor"]) {
      const name = `research-loop-${sessionId}-${role}`;
      const child = runContainer({
        image: args.image,
        name,
        job: jobs[role],
        mounts: mounts[role],
        logFile: path.join(runDir, "logs", `${role}.log`),
        platform: args.platform,
        cpu: args.cpu,
        memory: args.memory,
      });
      children[role] = { child, name };
    }
  }

  const agentEvents = {};
  const agentFatal = {};
  control.broker.events.on("agent-event", (evt) => {
    if (!evt?.role) return;
    if (evt.type === "exiting") agentEvents[evt.role] = evt.payload;
    if (evt.type === "fatal") agentFatal[evt.role] = evt.payload?.message || evt.payload;
  });

  let wallclock = null;
  if (args.wallclockMs > 0) {
    wallclock = setTimeout(() => {
      if (!control.broker.isClosed()) {
        control.broker.abort(`wallclock budget exceeded (${args.wallclockMs}ms)`);
      }
    }, args.wallclockMs);
  }

  const finished = await new Promise((resolve) => {
    let autoApproved = false;
    const timer = setInterval(() => {
      const snap = control.broker.snapshot();
      if (args.autoApprove && snap.state === "AWAITING_HUMAN" && !autoApproved) {
        autoApproved = true;
        control.broker.humanDecision({ action: "approve", text: "auto-approved (--auto-approve)" });
        return;
      }
      if (snap.state === "DONE" || snap.state === "ABORTED") {
        clearInterval(timer);
        resolve(snap);
      }
    }, 1000);
    timer.unref?.();
    for (const { child, name } of Object.values(children)) {
      child.on("error", (err) => {
        if (!control.broker.isClosed()) {
          const detail = err?.message || String(err);
          console.error(`[research-loop] ${name} failed to start: ${detail}`);
          control.broker.abort(`${name} failed to start: ${detail}`);
          clearInterval(timer);
          resolve(control.broker.snapshot());
        }
      });
      // Any agent exit before the session closes ends the run: an agent that is
      // still thinking keeps its process/container alive, so exit (even with
      // code 0, e.g. after an external SIGTERM) means it is gone for good.
      child.on("close", (code, signal) => {
        // Agents exit on their own once the session is done; that is not a failure.
        if (control.broker.snapshot().state === STATES.DONE) {
          control.broker.complete();
          clearInterval(timer);
          resolve(control.broker.snapshot());
          return;
        }
        if (!control.broker.isClosed()) {
          const role = name.includes("researcher")
            ? "researcher"
            : name.includes("advisor")
              ? "advisor"
              : name;
          const detail = agentFatal[role] ? `: ${agentFatal[role]}` : "";
          const how = signal ? `signal ${signal}` : `code ${code}`;
          console.error(`[research-loop] ${name} exited with ${how}${detail}`);
          control.broker.abort(`${name} exited with ${how}${detail}`);
          clearInterval(timer);
          resolve(control.broker.snapshot());
        }
      });
    }
  });

  if (wallclock) clearTimeout(wallclock);
  if (!["DONE", "ABORTED"].includes(control.broker.snapshot().state)) {
    control.broker.abort("orchestrator shutting down");
  }
  const snap = control.broker.snapshot();

  // Let containers flush and exit.
  await new Promise((r) => setTimeout(r, 1500));
  for (const { child, name } of Object.values(children)) {
    if (args.local) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    } else {
      stopContainer(name);
    }
  }

  const summary = {
    sessionId,
    label,
    task: args.task,
    researcherModel: args.researcherModel,
    advisorModel: args.advisorModel,
    skipSkills: args.skipSkills,
    maxSubagentDepth: args.maxSubagentDepth,
    delegation: args.delegation,
    token,
    state: control.broker.snapshot(),
    agentStats: agentEvents,
    agentErrors: Object.keys(agentFatal).length ? agentFatal : undefined,
    uiUrl: control.url,
    runDir,
  };
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(summary, null, 2));

  // Detailed statistics are derived from the on-disk transcripts, so they are
  // complete even when an agent crashed before emitting final stats.
  let stats = null;
  try {
    stats = buildRunStats({
      sessionId,
      task: args.task,
      runDir,
      models: { researcher: args.researcherModel, advisor: args.advisorModel },
      snapshot: snap,
      agentStats: agentEvents,
      agentErrors: agentFatal,
      transcriptDir,
      researcherSandbox,
      orchestratorStartedAt,
      orchestratorFinishedAt: Date.now(),
    });
    fs.writeFileSync(path.join(runDir, "stats.json"), JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error(`[research-loop] failed to write stats.json: ${e?.message || e}`);
  }

  console.log(`[research-loop] finished: ${snap.state} (${snap.terminalReason || "n/a"})`);
  console.log(`[research-loop] summary: ${path.join(runDir, "session.json")}`);
  if (stats) {
    console.log(renderStatsSummary(stats));
    console.log(`[research-loop] stats: ${path.join(runDir, "stats.json")}`);
  }
  control.close();
  await new Promise((r) => setTimeout(r, 300));
}

export { openBrowser };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[research-loop] fatal: ${e?.stack || e}`);
    process.exit(1);
  });
}
