#!/usr/bin/env node
/**
 * research-loop orchestrator.
 *
 * Creates a run directory, starts the control plane, launches the two agent
 * containers (or local processes with --local), and waits for the human to
 * approve final completion (or for a budget to be exceeded). The protocol the
 * agents follow is specified in docs/PROTOCOL.md.
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
import { readSessionLog } from "../control-plane/broker.mjs";
import { STATES } from "../control-plane/state-machine.mjs";
import { scanSkills } from "../agent/lib/skills.mjs";
import { resolveThinkingLevel } from "../agent/lib/model-providers.mjs";
import { agentCodeHash } from "../agent/lib/code-hash.mjs";
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
    taskFile: null,
    initialSandbox: null,
    researcherModel: "einfra:qwen3.8-27b",
    advisorModel: "einfra:deepseek-v4-flash",
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
    // null = unlimited nesting (minimum 1: the main session always delegates).
    maxSubagentDepth: null,
    // 0 = unlimited.
    maxPlanChanges: 0,
    maxSubagentRejections: 0,
    // How long agents ride out a provider/control-plane outage (backoff).
    retryBudgetMs: 8 * 3600e3,
    researcherContextWindow: null,
    advisorContextWindow: null,
    researcherMaxTokens: null,
    advisorMaxTokens: null,
    // Proceed (with a warning) when the agent image's code differs from this checkout.
    allowStaleImage: false,
  };
  // Settings given on the command line (they win over a resumed run's run.json).
  const explicit = new Set();
  const set = (key, value) => {
    args[key] = value;
    explicit.add(key);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "--task": set("task", next()); break;
      case "--task-file": set("taskFile", next()); break;
      case "--initial-sandbox": set("initialSandbox", next()); break;
      case "--researcher-model": set("researcherModel", next()); break;
      case "--advisor-model": set("advisorModel", next()); break;
      case "--config": set("config", next()); break;
      case "--image": set("image", next()); break;
      case "--run-dir": set("runDir", next()); break;
      case "--resume": set("resume", next()); break;
      case "--resume-prompt": set("resumePrompt", next()); break;
      case "--view": set("view", next()); break;
      case "--host": set("host", next()); break;
      case "--port": set("port", Number(next())); break;
      case "--max-handoffs": set("maxHandoffs", Number(next())); break;
      case "--wallclock-ms": set("wallclockMs", Number(next())); break;
      case "--max-turns-per-phase": set("maxTurnsPerPhase", Number(next())); break;
      case "--abort-timeout-ms": set("abortTimeoutMs", Number(next())); break;
      case "--phase-timeout-ms": set("phaseTimeoutMs", Number(next())); break;
      case "--thinking": set("thinking", next()); break; // fallback when a model spec has no ::effort
      case "--platform": set("platform", next()); break;
      case "--cpu": set("cpu", Number(next())); break;
      case "--memory": set("memory", next()); break;
      case "--local": set("local", true); break;
      case "--docker": set("docker", true); break;
      case "--faux": set("faux", true); break;
      case "--auto-approve": set("autoApprove", true); break;
      case "--no-open": set("open", false); break;
      case "--no-model-discovery": set("discoverModels", false); break;
      case "--skip-skills": set("skipSkills", true); break;
      case "--provider-retry-budget": set("retryBudgetMs", parseDuration(next(), a)); break;
      case "--max-subagent-depth": {
        const v = next();
        set("maxSubagentDepth", v === "unlimited" ? null : Number(v));
        if (args.maxSubagentDepth !== null && !(Number.isInteger(args.maxSubagentDepth) && args.maxSubagentDepth >= 1)) {
          throw new Error(`--max-subagent-depth must be a positive integer or 'unlimited', got ${v}`);
        }
        break;
      }
      case "--max-plan-changes": set("maxPlanChanges", nonNegativeInt(next(), a)); break;
      case "--max-subagent-rejections": set("maxSubagentRejections", nonNegativeInt(next(), a)); break;
      case "--researcher-context-window": set("researcherContextWindow", Number(next())); break;
      case "--advisor-context-window": set("advisorContextWindow", Number(next())); break;
      case "--researcher-max-tokens": set("researcherMaxTokens", Number(next())); break;
      case "--advisor-max-tokens": set("advisorMaxTokens", Number(next())); break;
      case "--allow-stale-image": set("allowStaleImage", true); break;
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
            "  --max-subagent-depth N   limit subagent nesting (minimum 1; default unlimited)",
            "  --max-plan-changes N     cap approved plan changes in the main session (default 0 = unlimited)",
            "  --max-subagent-rejections N  cap rejected delegations per goal (default 0 = unlimited)",
            "  --allow-stale-image      run even if the image's agent code differs from this checkout",
            "  --provider-retry-budget D  keep retrying a provider/control-plane outage with",
            "                exponential backoff for this long (e.g. 8h, 30m; 0 = no retries; default 8h)",
            "  --thinking LEVEL         reasoning effort for models without ::effort in their spec",
            "                (off|minimal|low|medium|high|xhigh|max; default medium)",
            "  --researcher-context-window N  --advisor-context-window N",
            "  --researcher-max-tokens N      --advisor-max-tokens N",
            "  --max-handoffs N  --wallclock-ms N  --max-turns-per-phase N",
            "    (--max-handoffs caps accepted handoffs in the whole run; 0 = unlimited)",
            "  --host <ip>  --port <n>  (WebUI bind address/port; defaults 127.0.0.1 / random)",
            "  --abort-timeout-ms N  --phase-timeout-ms N  (0 = disabled; default 0)",
            "  --resume <run-id|dir>    continue an interrupted session (fresh containers;",
            "                sandbox, goals and transcripts preserved)",
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
  if (!args.task && args.taskFile) set("task", fs.readFileSync(args.taskFile, "utf8"));
  if (!args.task.trim() && !args.view && !args.resume) {
    console.error("missing --task (or --task-file)");
    process.exit(2);
  }
  args.explicit = explicit;
  return args;
}

/** Arguments that describe one invocation, not the run: never saved or restored. */
const PER_INVOCATION = new Set([
  "task",
  "taskFile",
  "initialSandbox",
  "runDir",
  "resume",
  "resumePrompt",
  "view",
  "printJobs",
  "open",
  "explicit",
]);

/** Every launch setting of a run, as saved in run.json. */
export function launchSettings(args) {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !PER_INVOCATION.has(k)));
}

/**
 * Restore a run's saved launch settings (--resume / --view), except the ones
 * given on this command line. Returns the restored keys.
 */
export function restoreSettings(args, saved) {
  const restored = [];
  for (const [key, value] of Object.entries(saved || {})) {
    if (PER_INVOCATION.has(key) || !(key in args) || args.explicit?.has(key)) continue;
    args[key] = value;
    restored.push(key);
  }
  return restored;
}

function nonNegativeInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} expects a non-negative integer, got ${value}`);
  return n;
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

/** The `start` entry of a run's control log (task, skipSkills), if any. */
function readSessionStart(runDir) {
  return readSessionLog(runDir).find((e) => e.kind === "start") || {};
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
  // run.json of runs started before all settings were saved: the few it had.
  const legacy = Object.fromEntries(
    ["researcherModel", "advisorModel", "skipSkills", "maxSubagentDepth", "maxPlanChanges", "maxSubagentRejections"]
      .filter((k) => run[k] !== undefined)
      .map((k) => [k, run[k]]),
  );
  return {
    sessionId: meta.sessionId || run.sessionId || path.basename(runDir),
    task: meta.task || run.task || start.task || "",
    settings: run.settings || legacy,
    initialNote: run.initialNote || "",
    preinstalledSkills: run.preinstalledSkills || [],
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

const fauxGoal = (id, title) => ({
  id,
  title,
  description: `Demo goal ${id}: ${title}.`,
  acceptance: [`${id.toLowerCase()}.md exists and describes ${title.toLowerCase()}`],
  skills: [],
});

/**
 * Scripted offline scenario for --faux (no API keys, no model needed). Each
 * process answers its model calls in order, across all sessions it serves:
 * skills → plan → G1 (leaf S1) → G2 split into G2.1 (S3) and G2.2 (S4) by
 * orchestrator S2 → finish.
 */
function fauxScenario() {
  const leafResult = (id) =>
    fauxStep(
      `Implemented ${id}.`,
      "submit_result",
      {
        summary: `Wrote ${id.toLowerCase()}.md.`,
        report: `Wrote ${id.toLowerCase()}.md with the demo content.`,
        notes: "Nothing surprising in the demo environment.",
        artifacts: [`${id.toLowerCase()}.md`],
        verification: [`cat ${id.toLowerCase()}.md`],
      },
      { [`${id.toLowerCase()}.md`]: `# ${id}\nDemo output.\n` },
    );
  const delegate = (goalId, extra = {}) =>
    fauxStep(`Delegating ${goalId}.`, "propose_subagent", {
      goalId,
      mode: "full",
      instructions: `Write ${goalId.toLowerCase()}.md in /sandbox.`,
      justification: "A small, self-contained unit of work.",
      ...extra,
    });
  return {
    researcher: {
      provider: "faux",
      responses: [
        fauxStep("No reusable skill is needed for this demo.", "propose_skills", { summary: "none needed", noneNeeded: true, skills: [] }),
        fauxStep("The plan is clear.", "accept_plan", { feedback: "Clear and well ordered." }),
        delegate("G1"),
        leafResult("G1"), // S1
        fauxStep("G1 is done as planned.", "proceed", { assessment: "G1 met its goal; G2 still makes sense." }),
        delegate("G2", {
          mode: "split",
          instructions: "Draft the approach in two parts.",
          justification: "The approach has two distinct parts.",
          subgoals: [fauxGoal("G2.1", "Outline the approach"), fauxGoal("G2.2", "Detail the approach")],
        }),
        delegate("G2.1"), // S2
        leafResult("G2.1"), // S3
        fauxStep("G2.1 is done.", "proceed", { assessment: "On track." }), // S2
        delegate("G2.2"), // S2
        leafResult("G2.2"), // S4
        fauxStep("All subgoals are done.", "finish_session", { report: "G2.1 and G2.2 are written.", notes: "Demo only." }), // S2
        fauxStep("All goals are done.", "finish_session", { summary: "The demo task is complete: g1.md, g2.1.md, g2.2.md.", notes: "Demo only." }),
      ],
    },
    advisor: {
      provider: "faux",
      responses: [
        fauxStep("No skills needed.", "approve_skills", { feedback: "ok" }),
        fauxStep("Here is the plan.", "propose_plan", {
          goals: [fauxGoal("G1", "Survey the problem"), fauxGoal("G2", "Draft an approach")],
          rationale: "Survey first, then draft.",
        }),
        fauxStep("Well scoped.", "approve_subagent", { feedback: "go", conditions: ["keep it short"] }),
        fauxStep("Verified g1.md.", "accept_result", { feedback: "goal met", verification: ["read g1.md"] }), // S1
        fauxStep("The split is justified.", "approve_subagent", { feedback: "go" }),
        fauxStep("Well scoped.", "approve_subagent", { feedback: "go" }), // S2
        fauxStep("Verified g2.1.md.", "accept_result", { feedback: "ok", verification: ["read g2.1.md"] }), // S3
        fauxStep("Well scoped.", "approve_subagent", { feedback: "go" }), // S2
        fauxStep("Verified g2.2.md.", "accept_result", { feedback: "ok", verification: ["read g2.2.md"] }), // S4
        fauxStep("G2 is met as a whole.", "accept_completion", { feedback: "both parts fit together" }), // S2
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

function modelIdOnly(spec) {
  const raw = String(spec || "");
  const sep = raw.indexOf(":");
  const rest = sep === -1 ? raw : raw.slice(sep + 1);
  const effortSep = rest.lastIndexOf("::");
  return effortSep === -1 ? rest : rest.slice(0, effortSep);
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
    if (!args.explicit.has("task")) args.task = runMeta.task || "";
    const restored = restoreSettings(args, runMeta.settings);
    if (resumed && restored.length) {
      console.log(`[research-loop] restored from run.json: ${restored.map((k) => `${k}=${JSON.stringify(args[k])}`).join(", ")}`);
    }
    if (resumed && !runMeta.settings.image && !args.explicit.has("image")) {
      console.warn(
        `[research-loop] warning: the original run's image is unknown (older run.json); using ${args.image} (override with --image)`,
      );
    }
    if (resumed && (!runMeta.settings.researcherModel || !runMeta.settings.advisorModel)) {
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
  if (resumed || viewing) initialNote = runMeta.initialNote || "";

  // Skills shipped with the initial sandbox are installed for both agents: the
  // advisor gets its own copy (its sandbox is separate).
  let preinstalledSkills = runMeta?.preinstalledSkills || [];
  if (!resumed && !viewing) {
    const skillsDir = path.join(researcherSandbox, "skills");
    preinstalledSkills = scanSkills([{ dir: skillsDir, prefix: "/sandbox/skills" }]).map((s) => s.name);
    if (preinstalledSkills.length) {
      fs.cpSync(skillsDir, path.join(advisorSandbox, "skills"), { recursive: true, force: true });
      console.log(`[research-loop] preinstalled skills: ${preinstalledSkills.join(", ")}`);
    }
  }

  const token = randomBytes(24).toString("hex");
  // The control-plane log (source of truth for resume/view) and the readable
  // records live in the run folder, outside every agent mount.
  const replayEntries = resumed || viewing ? readSessionLog(runDir) : null;
  const controlOpts = {
    token,
    task: args.task,
    label,
    runDir,
    transcriptDir,
    sessionId,
    host: args.host,
    port: args.port,
    maxHandoffs: args.maxHandoffs,
    initialNote,
    skipSkills: args.skipSkills,
    preinstalledSkills,
    maxSubagentDepth: args.maxSubagentDepth,
    maxPlanChanges: args.maxPlanChanges,
    maxSubagentRejections: args.maxSubagentRejections,
    // Agents must run this checkout's agent code (catches stale Docker images).
    expectedCodeHash: agentCodeHash(REPO_ROOT),
    allowStaleImage: args.allowStaleImage,
    image: args.local ? null : args.image,
  };

  const configPath = path.isAbsolute(args.config) ? args.config : path.resolve(args.config);

  // ---- View-only mode: replay history + final state, no agents/containers. ----
  if (viewing) {
    if (!replayEntries.some((e) => e.kind === "start")) {
      throw new Error(`cannot view ${runDir}: no control log (control/session.jsonl); runs from before protocol v2 need an older version`);
    }
    const control = await startControlPlane({ ...controlOpts, replayEntries, viewOnly: true });
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

  // Reasoning effort per role: the model spec's ::effort, else --thinking.
  for (const role of ["researcher", "advisor"]) {
    const r = resolveThinkingLevel(args[`${role}Model`], args.thinking);
    if (r.error) throw new Error(r.error);
    console.log(`[research-loop] ${role} reasoning effort: ${r.level} (${r.source})`);
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

  // When resuming, the control plane replays its log so the run continues
  // where the previous process left off.
  if (resumed) {
    if (!replayEntries.some((e) => e.kind === "start")) {
      throw new Error(
        `cannot resume ${runDir}: no control log (control/session.jsonl); start a new run (runs from before protocol v2 cannot be resumed)`,
      );
    }
    const terminal = [...replayEntries].reverse().find((e) => e.kind === "terminal");
    if (terminal?.status === "done") throw new Error(`session ${sessionId} already completed; use --view to review it`);
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
        initialNote,
        preinstalledSkills,
        protocol: 2,
        // Every launch setting; --resume restores what is not passed again.
        settings: launchSettings(args),
      },
      null,
      2,
    ),
  );

  const control = await startControlPlane({ ...controlOpts, replayEntries });
  console.log(`[research-loop] session ${sessionId}${resumed ? " (resumed)" : ""}`);
  console.log(`[research-loop] UI: ${control.url}`);

  if (resumed) {
    const r = control.broker.resume(args.resumePrompt || "");
    if (!r.ok) throw new Error(`cannot resume: ${r.error}`);
    console.log(`[research-loop] resumed: session ${r.agentId}, ${r.expecting || "nobody"} to act`);
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
    maxPlanChanges: args.maxPlanChanges,
    maxSubagentRejections: args.maxSubagentRejections,
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
      goalTree: control.broker.goalTree().goals,
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
