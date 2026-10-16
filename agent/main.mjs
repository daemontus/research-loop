#!/usr/bin/env node
/**
 * research-loop agent entrypoint (runs inside a container).
 *
 * Reads a JSON job (from RESEARCH_LOOP_JOB env or stdin), builds the role's
 * pi-agent-core session, registers with the host broker, then alternates:
 *   wait for a handoff -> run a phase -> send our handoff.
 *
 * The process stays alive for the whole session so installed tools and
 * conversation state persist.
 *
 * stdin job shape:
 *   {
 *     role: "researcher" | "advisor",
 *     model: "provider:model::effort",
 *     brokerUrl, token, sessionId,
 *     sandbox, configDir, prefetchPath, extraRoots, transcriptPath,
 *     task, maxTurnsPerPhase, abortTimeoutMs,
 *     provider?, apiKey?, configPath?, faux?, thinkingLevel?
 *   }
 */
import fs from "node:fs";
import path from "node:path";

import { AgentSession } from "./lib/agent-runner.mjs";
import { clientSessionId } from "./lib/client-identity.mjs";
import { createBrokerClient } from "./lib/broker-client.mjs";
import { createPartialStreamer } from "./lib/partial-stream.mjs";
import {
  bindControlTools,
  advisorControlToolDefs,
  researcherControlToolDefs,
  SKILLS_CONTROL_TOOLS,
} from "./lib/control-tools.mjs";
import { modelSupportsImages } from "./lib/model-capabilities.mjs";
import { buildModels, parseModelSpec, resolveModel, assertProviderConfigured } from "./lib/model-providers.mjs";
import { buildAdvisorPrompt, buildResearcherPrompt } from "./lib/prompts.mjs";
import { renderInbound, ROOT_AGENT_ID } from "./lib/protocol.mjs";
import { scanSkills, renderInstalledSkills } from "./lib/skills.mjs";
import { makeInstallSkillTool } from "./lib/skill-tools.mjs";
import { makeTools } from "./lib/tools.mjs";
import { createTranscriptWriter } from "./lib/transcript.mjs";

function readJobFromStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function loadJob() {
  if (process.env.RESEARCH_LOOP_JOB) {
    const job = JSON.parse(process.env.RESEARCH_LOOP_JOB);
    // The job carries the session token and API keys; keep it out of the
    // environment inherited by agent-spawned shells.
    delete process.env.RESEARCH_LOOP_JOB;
    return job;
  }
  const raw = await readJobFromStdin();
  if (!raw.trim()) throw new Error("no job on stdin (and RESEARCH_LOOP_JOB is unset)");
  return JSON.parse(raw);
}

/** The researcher's GOALS.md for an agent (a subagent keeps its own). */
function researcherGoalsPath(role, sandbox, extraRoots, subagentId = null) {
  const rel = subagentId ? path.join("agents", subagentId, "GOALS.md") : "GOALS.md";
  if (role === "advisor") {
    const root = (extraRoots || []).find((r) => r.prefix === "/researcher-sandbox");
    if (root && root.dir) return path.join(root.dir, rel);
  }
  return path.join(sandbox, rel);
}

function readGoalsSnapshot(goalsPath) {
  try {
    return fs.readFileSync(goalsPath, "utf8");
  } catch {
    return "";
  }
}

/** Skill roots visible to this role (sandbox skills; advisor also reads RS). */
function skillRootsFor(role, sandbox, extraRoots) {
  const roots = [{ dir: path.join(sandbox, "skills"), prefix: "/sandbox/skills" }];
  if (role === "advisor") {
    const rs = (extraRoots || []).find((r) => r.prefix === "/researcher-sandbox");
    if (rs && rs.dir) {
      roots.push({ dir: path.join(rs.dir, "skills"), prefix: "/researcher-sandbox/skills" });
    }
  }
  return roots;
}

async function main() {
  const job = await loadJob();
  const role = job.role === "advisor" ? "advisor" : "researcher";
  const log = (msg) => process.stderr.write(`[${role}] ${msg}\n`);
  const sandbox = job.sandbox || "/sandbox";
  const configDir = job.configDir || (fs.existsSync("/config") ? "/config" : null);
  const prefetchPath = job.prefetchPath || "/prefetch";
  const extraRoots =
    Array.isArray(job.extraRoots) && job.extraRoots.length
      ? job.extraRoots
      : role === "advisor"
        ? [{ prefix: "/researcher-sandbox", dir: "/researcher-sandbox" }]
        : [];

  fs.mkdirSync(sandbox, { recursive: true });

  if (job.provider?.id && !job.apiKey) {
    throw new Error(
      `no API key provided for provider '${job.provider.id}'; refusing to start ` +
        "(the orchestrator should resolve and pass it).",
    );
  }

  const { models } = buildModels({
    configPath: job.configPath || null,
    provider: job.provider || null,
    apiKey: job.apiKey || null,
    providerId: parseModelSpec(job.model).providerId || null,
    extraModels: job.extraModels || null,
    faux: job.faux || null,
  });
  const resolved = resolveModel(models, job.model);
  if (resolved.error) throw new Error(resolved.error);
  // CLI context/output overrides for built-in catalog models.
  const model = job.modelLimits ? { ...resolved.model, ...job.modelLimits } : resolved.model;
  await assertProviderConfigured(models, model);

  const rootTranscriptPath = job.transcriptPath || `/transcripts/${role}.jsonl`;
  // Process-level log (lifecycle, broker trouble); per-agent conversations get
  // their own writers below.
  const transcript = createTranscriptWriter(rootTranscriptPath, role, { agentId: ROOT_AGENT_ID });

  const supportsImage = modelSupportsImages(model);
  const skipSkills = Boolean(job.skipSkills);
  const maxSubagentDepth =
    job.maxSubagentDepth === null || job.maxSubagentDepth === undefined
      ? null
      : Number(job.maxSubagentDepth);
  const genericTools = makeTools(sandbox, {
    configDir,
    prefetchPath,
    extraRoots,
    supportsImage,
  });

  const broker = createBrokerClient({
    brokerUrl: job.brokerUrl,
    role,
    token: job.token,
  });

  /**
   * One conversation (AgentSession) per agent: the root session plus any
   * subagent the control plane routes to this process. Created lazily on the
   * first envelope for that agent; subagent metadata rides on its envelopes.
   * @type {Map<string, { session: AgentSession, controlDefs: object[], transcript: object, goalsPath: string, skillRoots: object[] }>}
   */
  const contexts = new Map();

  function createContext(agentId, meta) {
    const subagent = agentId === ROOT_AGENT_ID ? null : { ...(meta || {}), id: agentId };
    const depth = subagent?.depth || 0;
    const canSpawnSubagents =
      role === "researcher" && (maxSubagentDepth == null || depth + 1 <= maxSubagentDepth);
    const agentTranscriptPath = subagent
      ? path.join(path.dirname(rootTranscriptPath), "agents", agentId, `${role}.jsonl`)
      : rootTranscriptPath;
    const agentTranscript = subagent
      ? createTranscriptWriter(agentTranscriptPath, role, { agentId })
      : transcript;
    if (subagent && role === "researcher") {
      fs.mkdirSync(path.join(sandbox, "agents", agentId), { recursive: true });
    }
    const systemPrompt =
      role === "researcher"
        ? buildResearcherPrompt({
            sandbox,
            configDir,
            supportsImage,
            task: job.task || "",
            skipSkills,
            subagent,
            canSpawnSubagents,
            maxSubagentDepth,
          })
        : buildAdvisorPrompt({ sandbox, configDir, supportsImage, task: job.task || "", subagent });

    const controlState = { pendingHandoff: null };
    const controller = {
      setHandoff: (h) => {
        if (controlState.pendingHandoff) return false;
        controlState.pendingHandoff = h;
        return true;
      },
    };
    const goalsPath = researcherGoalsPath(role, sandbox, extraRoots, subagent ? agentId : null);
    const skillRoots = skillRootsFor(role, sandbox, extraRoots);
    const skillTools = role === "researcher" && !subagent ? [makeInstallSkillTool(sandbox)] : [];
    let controlDefs =
      role === "researcher" ? researcherControlToolDefs() : advisorControlToolDefs();
    if (subagent) controlDefs = controlDefs.filter((d) => !SKILLS_CONTROL_TOOLS.has(d.name));
    if (!canSpawnSubagents) controlDefs = controlDefs.filter((d) => d.name !== "propose_subagent");
    const tools = [...genericTools, ...skillTools, ...bindControlTools(controlDefs, controller)];

    const session = new AgentSession({
      role,
      model,
      models,
      systemPrompt,
      tools,
      sandbox,
      goalsPath,
      transcript: agentTranscript,
      controlState,
      thinkingLevel: job.thinkingLevel || resolved.effort || "off",
      maxTurnsPerPhase: job.maxTurnsPerPhase ?? 1000,
      abortTimeoutMs: job.abortTimeoutMs ?? 0,
      phaseTimeoutMs: job.phaseTimeoutMs ?? 0,
      // Each agent is its own provider-side session; the root keeps the
      // historical id so resumed runs stay stable.
      clientSessionId: clientSessionId(job.sessionId || "", subagent ? `${role}:${agentId}` : role),
    });
    session.start();
    // Stream in-progress thinking/text to the WebUI as it arrives.
    session.partialStreamer = createPartialStreamer((ops) => broker.partial(ops, agentId));
    agentTranscript.write("system", {
      content: subagent
        ? `subagent ${agentId} session started (role=${role}, parent=${subagent.parentId}, depth=${depth})`
        : `agent started (role=${role}, model=${job.model})`,
    });
    const ctx = { agentId, session, controlDefs, transcript: agentTranscript, goalsPath, skillRoots };
    contexts.set(agentId, ctx);
    return ctx;
  }

  function contextFor(envelope) {
    const agentId = envelope.agentId || ROOT_AGENT_ID;
    return contexts.get(agentId) || createContext(agentId, envelope.agent);
  }

  function closeContext(agentId) {
    const ctx = contexts.get(agentId);
    if (!ctx || agentId === ROOT_AGENT_ID) return;
    ctx.transcript.write("system", { content: `subagent ${agentId} finished`, stats: ctx.session.stats() });
    ctx.transcript.close();
    contexts.delete(agentId);
  }

  const rootCtx = createContext(ROOT_AGENT_ID, null);
  log(`started role=${role} model=${job.model} sandbox=${sandbox} transcript=${rootTranscriptPath}`);

  await broker.register();
  await broker.event("registered", { role, model: job.model });
  log(`registered with broker at ${job.brokerUrl}`);

  let cursor = 0;
  let done = false;


  const sendHandoff = async (ctx, handoff) => {
    ctx.transcript.write("handoff", {
      direction: "out",
      handoffKind: handoff.kind,
      goalId: handoff.goalId,
      text: handoff.text,
      payload: handoff.payload,
    });
    const res = await broker.send({ ...handoff, agentId: ctx.agentId });
    if (res && res.ok === false) {
      // The broker rejected the handoff and queued a correction prompt for us;
      // keep the session alive so the next loop iteration can act on it.
      ctx.transcript.write("system", {
        content:
          `handoff rejected by broker: ${res.error || "invalid"} ` +
          `(state=${res.state || "?"}); awaiting correction prompt`,
      });
      log(`handoff rejected: ${res.error || "invalid"} (state=${res.state || "?"})`);
    }
    return res;
  };

  const tryFinish = async (ctx) => {
    const handoff = ctx.session.takeHandoff();
    if (!handoff) return false;
    await sendHandoff(ctx, handoff);
    return true;
  };

  // Run one phase and guarantee we never silently stall: either a handoff is
  // produced, or a fatal error is thrown (which exits non-zero and aborts).
  const runPhase = async (ctx, prompt) => {
    const { session, controlDefs, transcript: tx } = ctx;
    const first = await session.runPrompt(prompt);
    if (await tryFinish(ctx)) return;
    const reason = String(first.stopReason || "").toLowerCase();
    if (first.error || reason === "error" || reason === "aborted") {
      throw new Error(
        `provider failure during ${role} phase: ${first.error || `stopReason=${first.stopReason}`}`,
      );
    }
    // The model stopped without calling a control tool; nudge it, bounded.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      tx.write("system", {
        content: `no control-tool handoff (stopReason=${first.stopReason}); correction ${attempt}/3`,
      });
      const correction = [
        `Your previous turn ended without a handoff (stopReason=${first.stopReason}).`,
        "Every phase MUST end by calling exactly one control tool:",
        ...controlDefs.map((d) => `  - ${d.name}`),
        "Continue from where you are and call the appropriate control tool now.",
      ].join("\n");
      const next = await session.runPrompt(correction);
      if (await tryFinish(ctx)) return;
      const r = String(next.stopReason || "").toLowerCase();
      if (next.error || r === "error" || r === "aborted") {
        throw new Error(
          `provider failure while requesting handoff: ${next.error || `stopReason=${next.stopReason}`}`,
        );
      }
    }
    throw new Error("agent never produced a control-tool handoff");
  };

  const onSignal = (signal) => {
    if (done) return;
    done = true;
    for (const ctx of contexts.values()) {
      try {
        ctx.session.abort();
      } catch {
        // ignore
      }
    }
    transcript.write("system", { content: `termination signal (${signal}) received; exiting` });
    for (const ctx of contexts.values()) ctx.transcript.close();
    transcript.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const maxPollFailures = Math.max(1, Number(job.maxPollFailures) || 20);
  let pollFailures = 0;

  try {
    while (!done) {
      let batch;
      try {
        batch = await broker.poll(cursor);
        pollFailures = 0;
      } catch (e) {
        pollFailures += 1;
        transcript.write("system", {
          content: `broker poll failed (${pollFailures}/${maxPollFailures}): ${e?.message || e}`,
        });
        if (pollFailures >= maxPollFailures) {
          throw new Error(
            `broker unreachable after ${pollFailures} attempts: ${e?.message || e}`,
          );
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      cursor = batch.cursor ?? cursor;
      for (const envelope of batch.messages || []) {
        if (envelope.role === "control") {
          if (envelope.kind === "session_done") {
            transcript.write("system", { content: "session_done received; exiting" });
            done = true;
            break;
          }
          if (envelope.kind === "abort") {
            transcript.write("system", { content: `abort received: ${envelope.text || ""}` });
            for (const ctx of contexts.values()) ctx.session.abort();
            done = true;
            break;
          }
          if (envelope.kind === "agent_done") {
            closeContext(envelope.agentId);
            continue;
          }
          if (envelope.kind === "start" || envelope.kind === "prompt") {
            const ctx = contextFor(envelope);
            ctx.transcript.write("system", { content: `${envelope.kind} received` });
            await runPhase(ctx, envelope.text || "");
            continue;
          }
        }

        const ctx = contextFor(envelope);
        const prompt = renderInbound(envelope, {
          goalsSnapshot: readGoalsSnapshot(ctx.goalsPath),
          skillsSnapshot: renderInstalledSkills(scanSkills(ctx.skillRoots)),
        });
        ctx.transcript.write("handoff", {
          direction: "in",
          from: envelope.role,
          handoffKind: envelope.kind,
          goalId: envelope.goalId ?? null,
          text: envelope.text || "",
          payload: envelope.payload || {},
        });
        await runPhase(ctx, prompt);
      }
    }
  } catch (e) {
    const message = e?.message || String(e);
    transcript.write("system", { content: `FATAL: ${message}` });
    log(`FATAL: ${message}`);
    await broker.event("fatal", { message });
    await new Promise((r) => setTimeout(r, 200));
    for (const ctx of contexts.values()) ctx.transcript.close();
    transcript.close();
    process.exit(1);
  }

  const stats = rootCtx.session.stats();
  transcript.write("system", { content: "agent exiting", stats });
  await broker.event("exiting", stats);
  for (const ctx of contexts.values()) ctx.transcript.close();
  transcript.close();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack || e}\n`);
  process.exitCode = 1;
});
