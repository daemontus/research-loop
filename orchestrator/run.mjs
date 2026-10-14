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
function fauxStep(text, toolName, payload) {
  return {
    content: [
      { type: "text", text },
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
        fauxStep("Decomposed task; proposing G1.", "submit_plan", {
          goalId: "G1",
          title: "Survey the problem",
          plan: ["Collect background", "Write notes"],
          acceptanceCriteria: ["notes.md exists", "summarizes the problem"],
        }),
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
function buildResumePrompt({ task, initialState, expected, goal, resumePrompt }) {
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
    `The previous session was interrupted in state ${initialState}${goal ? ` on goal ${goal}` : ""}.`,
    expected
      ? `You (${expected}) were expected to act next; carry on with that responsibility.`
      : "Control returns to the human; the session awaits a decision.",
    ...(resumePrompt ? ["", "## Extra instructions from the human", resumePrompt] : []),
    "",
    "## Broad research task",
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
  if (!provider) return { provider: null, note: null };

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

  const configPath = path.isAbsolute(args.config) ? args.config : path.resolve(args.config);

  // ---- View-only mode: replay history + final state, no agents/containers. ----
  if (viewing) {
    const control = await startControlPlane({
      token,
      task: args.task,
      transcriptDir,
      sessionId,
      goalsPath,
      host: args.host,
      port: args.port,
      maxHandoffs: args.maxHandoffs,
      initialNote,
      skipSkills: args.skipSkills,
      installedSkillsPath: path.join(researcherSandbox, "skills"),
      viewOnly: true,
      seedState: runMeta?.state || replaySessionLog(transcriptDir).state,
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
    researcherCreds = resolveCredentials(args.researcherModel, configPath);
    advisorCreds = resolveCredentials(args.advisorModel, configPath);
    if (!researcherCreds) {
      throw new Error(
        `No credentials for researcher model ${args.researcherModel}. Check pi_config.json and env/auth.json.`,
      );
    }
    if (!advisorCreds) {
      throw new Error(
        `No credentials for advisor model ${args.advisorModel}. Check pi_config.json and env/auth.json.`,
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
    replay = replaySessionLog(transcriptDir);
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
        task: args.task,
        researcherModel: args.researcherModel,
        advisorModel: args.advisorModel,
        skipSkills: args.skipSkills,
      },
      null,
      2,
    ),
  );

  const control = await startControlPlane({
    token,
    task: args.task,
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
  });
  console.log(`[research-loop] session ${sessionId}${resumed ? " (resumed)" : ""}`);
  console.log(`[research-loop] UI: ${control.url}`);

  if (resumed) {
    const expected = expectedRoleForState(replay.state.state);
    const goal = replay.state.currentGoalId;
    const resumeText = buildResumePrompt({
      task: args.task,
      initialState: replay.state.state,
      expected,
      goal,
      resumePrompt: args.resumePrompt,
      skipSkills: args.skipSkills,
    });
    control.broker.resume(resumeText);
    console.log(`[research-loop] resumed in state ${replay.state.state} (${expected || "awaiting human"})`);
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
    task: args.task,
    researcherModel: args.researcherModel,
    advisorModel: args.advisorModel,
    skipSkills: args.skipSkills,
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
