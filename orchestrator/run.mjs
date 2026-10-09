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
  discoverModelLimits,
  providerForDocker,
  resolveCredentials,
} from "./credentials.mjs";
import { imageExists, runContainer, stopContainer } from "./docker.mjs";
import { buildRunStats, renderStatsSummary } from "./stats.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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
    port: 0,
    maxHandoffs: 200,
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
    const next = () => argv[++i];
    switch (a) {
      case "--task": args.task = next(); break;
      case "--task-file": args.taskFile = next(); break;
      case "--initial-sandbox": args.initialSandbox = next(); break;
      case "--researcher-model": args.researcherModel = next(); break;
      case "--advisor-model": args.advisorModel = next(); break;
      case "--config": args.config = next(); break;
      case "--image": args.image = next(); break;
      case "--run-dir": args.runDir = next(); break;
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
      case "--skip-skills": args.skipSkills = true; break;
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
            "  --no-open                --no-model-discovery  --skip-skills",
            "  --researcher-context-window N  --advisor-context-window N",
            "  --researcher-max-tokens N      --advisor-max-tokens N",
            "  --max-handoffs N  --wallclock-ms N  --max-turns-per-phase N",
            "    (--max-handoffs caps researcher goal steps: proposals + results)",
            "  --abort-timeout-ms N  --phase-timeout-ms N  (0 = disabled; default 0)",
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
  }
  if (!args.task.trim()) {
    console.error("missing --task (or --task-file)");
    process.exit(2);
  }
  return args;
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
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
  const sessionId = timestampId();
  const runDir = path.resolve(args.runDir || path.join(REPO_ROOT, "runs", sessionId));
  const transcriptDir = path.join(runDir, "transcripts");
  const researcherSandbox = path.join(runDir, "researcher-sandbox");
  const advisorSandbox = path.join(runDir, "advisor-sandbox");
  for (const d of [runDir, transcriptDir, researcherSandbox, advisorSandbox]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Optionally seed the researcher sandbox with host-provided resources.
  let initialNote = "";
  if (args.initialSandbox) {
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

  const control = await startControlPlane({
    token,
    task: args.task,
    transcriptDir,
    sessionId,
    goalsPath,
    port: args.port,
    maxHandoffs: args.maxHandoffs,
    initialNote,
    skipSkills: args.skipSkills,
    installedSkillsPath: path.join(researcherSandbox, "skills"),
  });
  console.log(`[research-loop] session ${sessionId}`);
  console.log(`[research-loop] UI: ${control.url}`);

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
  };

  const jobs = {
    researcher: {
      ...commonJob,
      role: "researcher",
      model: args.researcherModel,
      brokerUrl: args.local ? `http://127.0.0.1:${control.port}` : "http://host.docker.internal:8088",
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
      brokerUrl: args.local ? `http://127.0.0.1:${control.port}` : "http://host.docker.internal:8088",
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

  if (args.printJobs) {
    console.log(JSON.stringify(jobs, null, 2));
    control.close();
    return;
  }

  if (args.open) openBrowser(control.url);

  // In docker mode the broker URL uses a fixed in-container port; bind the
  // control plane to that port on the host side is not possible with a random
  // port, so we rewrite to the actual port but keep host.docker.internal.
  if (!args.local) {
    for (const job of Object.values(jobs)) {
      job.brokerUrl = `http://host.docker.internal:${control.port}`;
      if (job.provider) job.provider = providerForDocker(job.provider);
    }
    if (!imageExists(args.image)) {
      throw new Error(
        `Docker image ${args.image} not found. Build it with: docker build -f Dockerfile.agent -t ${args.image} .`,
      );
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
      child.on("close", (code) => {
        if (code !== 0 && !control.broker.isClosed()) {
          const role = name.includes("researcher")
            ? "researcher"
            : name.includes("advisor")
              ? "advisor"
              : name;
          const detail = agentFatal[role] ? `: ${agentFatal[role]}` : "";
          console.error(`[research-loop] ${name} exited with code ${code}${detail}`);
          control.broker.abort(`${name} exited with code ${code}${detail}`);
          clearInterval(timer);
          resolve(control.broker.snapshot());
        }
      });
    }
  });

  if (wallclock) clearTimeout(wallclock);
  const snap = control.broker.snapshot();
  if (snap.state !== "DONE" && snap.state !== "ABORTED") {
    control.broker.abort("orchestrator shutting down");
  }

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
