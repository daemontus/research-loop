/**
 * Run summary statistics.
 *
 * Written to `<runDir>/stats.json` when a session terminates (DONE or ABORTED).
 * Everything is derived from the on-disk JSONL transcripts and the researcher
 * sandbox, so the file is complete even when an agent crashed before emitting
 * its final "exiting" stats (see agent/main.mjs).
 */
import fs from "node:fs";
import path from "node:path";

const ROLES = ["researcher", "advisor"];
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
}

function addUsage(target, usage) {
  if (!usage) return;
  for (const key of USAGE_KEYS) target[key] += Number(usage[key]) || 0;
}

function finalizeUsage(usage) {
  usage.totalTokens = USAGE_KEYS.reduce((sum, key) => sum + usage[key], 0);
  return usage;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Read a JSONL file, tolerating missing files and truncated final lines. */
export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // ignore partial/corrupt line
    }
  }
  return entries;
}

function summarizeRole(entries) {
  const tokens = emptyUsage();
  const messages = { assistant: 0, user: 0, toolResult: 0, system: 0, total: 0 };
  const toolCalls = {};
  let toolCallTotal = 0;
  let errors = 0;
  let lengthStops = 0;
  let reasoningChars = 0;
  let firstTs = null;
  let lastTs = null;
  const handoffsByKind = {};
  let handoffsIn = 0;
  let handoffsOut = 0;
  const retries = { compaction: 0, abort: 0, rateLimit: 0, contextOverflow: 0, providerError: 0 };

  for (const entry of entries) {
    const ts = toFiniteNumber(entry.ts) ?? toFiniteNumber(entry.timestamp);
    if (ts !== null) {
      firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
      lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    }

    if (entry.kind === "message") {
      messages.total += 1;
      if (entry.role === "assistant") {
        messages.assistant += 1;
        addUsage(tokens, entry.usage);
        const reason = String(entry.stopReason || "").toLowerCase();
        if (reason === "error") errors += 1;
        if (reason === "length") lengthStops += 1;
        if (typeof entry.reasoning === "string") reasoningChars += entry.reasoning.length;
        for (const call of entry.tool_calls || []) {
          toolCallTotal += 1;
          const name = call?.name || "unknown";
          toolCalls[name] = (toolCalls[name] || 0) + 1;
        }
      } else if (entry.role === "user") {
        messages.user += 1;
      } else if (entry.role === "toolResult") {
        messages.toolResult += 1;
      }
    } else if (entry.kind === "system") {
      messages.system += 1;
      messages.total += 1;
      const content = String(entry.content || "");
      if (content.startsWith("compaction:")) retries.compaction += 1;
      else if (content.startsWith("abort-retry:")) retries.abort += 1;
      else if (content.startsWith("rate-limit-retry:")) retries.rateLimit += 1;
      else if (content.startsWith("context-overflow-retry:")) retries.contextOverflow += 1;
      else if (content.startsWith("provider-error-retry:")) retries.providerError += 1;
    } else if (entry.kind === "handoff") {
      if (entry.direction === "in") {
        handoffsIn += 1;
      } else {
        handoffsOut += 1;
        const kind = entry.handoffKind || "handoff";
        handoffsByKind[kind] = (handoffsByKind[kind] || 0) + 1;
      }
    }
  }

  return {
    tokens: finalizeUsage(tokens),
    messages,
    toolCalls: { total: toolCallTotal, byTool: toolCalls },
    errors,
    lengthStops,
    reasoningChars,
    firstTs,
    lastTs,
    handoffsByKind,
    handoffsIn,
    handoffsOut,
    retries,
  };
}

function listSubagentIds(transcriptDir) {
  try {
    return fs
      .readdirSync(path.join(transcriptDir, "agents"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** Recursively list files under `root`, skipping the given directory names. */
function listFiles(root, skipDirs = new Set()) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (skipDirs.has(ent.name) || ent.name.startsWith(".")) continue;
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, childRel);
      } else if (ent.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          // ignore
        }
        files.push({ path: childRel, size });
      }
    }
  };
  walk(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function listSkills(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)
      .sort();
  } catch {
    return [];
  }
}

function readSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function mergeRetries(transcriptRetries, reported) {
  const base = { ...transcriptRetries };
  if (reported) {
    if (Number.isFinite(reported.compacted)) base.compaction = reported.compacted;
    if (Number.isFinite(reported.proximityCompactions)) base.proximity = reported.proximityCompactions;
    if (Number.isFinite(reported.abortRetries)) base.abort = reported.abortRetries;
    if (Number.isFinite(reported.rateLimitRetries)) base.rateLimit = reported.rateLimitRetries;
    if (Number.isFinite(reported.contextOverflowRetries)) {
      base.contextOverflow = reported.contextOverflowRetries;
    }
    if (Number.isFinite(reported.providerErrorRetries)) {
      base.providerError = reported.providerErrorRetries;
    }
  }
  return base;
}

/**
 * Build the run statistics object.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.task
 * @param {string} opts.runDir
 * @param {{researcher?: string, advisor?: string}} opts.models
 * @param {object} opts.snapshot broker snapshot (`control.broker.snapshot()`)
 * @param {Record<string, object>} [opts.agentStats] per-role `session.stats()`
 * @param {Record<string, string>} [opts.agentErrors] per-role fatal message
 * @param {string} opts.transcriptDir
 * @param {string} opts.researcherSandbox
 * @param {number} [opts.orchestratorStartedAt]
 * @param {number} [opts.orchestratorFinishedAt]
 */
export function buildRunStats(opts) {
  const {
    sessionId,
    task,
    runDir,
    models = {},
    snapshot = {},
    agentStats = {},
    agentErrors = {},
    transcriptDir,
    researcherSandbox,
    orchestratorStartedAt,
    orchestratorFinishedAt,
  } = opts;

  // Subagent transcripts live under transcripts/agents/<id>/; per-role totals
  // include them, and each subagent is also summarized on its own.
  const subagentIds = listSubagentIds(transcriptDir);
  const byRole = {};
  const goalIds = new Set();
  const subagents = {};
  for (const role of ROLES) {
    const entries = readJsonl(path.join(transcriptDir, `${role}.jsonl`));
    for (const entry of entries) {
      if (entry.kind === "handoff" && entry.goalId) goalIds.add(String(entry.goalId));
    }
    for (const id of subagentIds) {
      const sub = readJsonl(path.join(transcriptDir, "agents", id, `${role}.jsonl`));
      const summary = summarizeRole(sub);
      (subagents[id] ||= { tokens: {}, turns: {} }).tokens[role] = summary.tokens;
      subagents[id].turns[role] = summary.messages.assistant;
      entries.push(...sub);
    }
    byRole[role] = summarizeRole(entries);
  }

  const tokens = emptyUsage();
  for (const role of ROLES) {
    for (const key of USAGE_KEYS) tokens[key] += byRole[role].tokens[key];
  }
  finalizeUsage(tokens);

  const now = Date.now();
  const sessionStarted = toFiniteNumber(snapshot.startedAt);
  const sessionFinished = toFiniteNumber(snapshot.finishedAt);
  const finishedAt = orchestratorFinishedAt ?? now;
  const startedAt = orchestratorStartedAt ?? sessionStarted;
  const sessionMs =
    sessionStarted !== null && sessionFinished !== null ? sessionFinished - sessionStarted : null;
  const totalMs = startedAt !== null ? finishedAt - startedAt : null;

  const byRoleMs = {};
  for (const role of ROLES) {
    const { firstTs, lastTs } = byRole[role];
    byRoleMs[role] = firstTs !== null && lastTs !== null ? lastTs - firstTs : null;
  }

  const handoffsByKind = {};
  let handoffsOut = 0;
  let handoffsIn = 0;
  for (const role of ROLES) {
    for (const [kind, count] of Object.entries(byRole[role].handoffsByKind)) {
      handoffsByKind[kind] = (handoffsByKind[kind] || 0) + count;
    }
    handoffsOut += byRole[role].handoffsOut;
    handoffsIn += byRole[role].handoffsIn;
  }

  const turns = {};
  const messages = {};
  const toolCalls = {};
  const recovery = {};
  for (const role of ROLES) {
    const s = byRole[role];
    const reported = agentStats[role];
    turns[role] = Number.isFinite(reported?.turns) ? reported.turns : s.messages.assistant;
    messages[role] = s.messages;
    toolCalls[role] = s.toolCalls;
    recovery[role] = {
      ...mergeRetries(s.retries, reported),
      warnings: Array.isArray(reported?.warnings) ? reported.warnings.length : 0,
      errorTurns: s.errors,
    };
  }

  const goalList = [...goalIds].sort();
  const decisions = Array.isArray(snapshot.humanDecisions) ? snapshot.humanDecisions : [];

  const skillsDir = path.join(researcherSandbox, "skills");
  const skillNames = listSkills(skillsDir);
  const artifactFiles = listFiles(researcherSandbox, new Set(["skills"]));
  const artifactsBytes = artifactFiles.reduce((sum, f) => sum + f.size, 0);

  const errors = {};
  for (const role of ROLES) {
    if (agentErrors[role]) errors[role] = agentErrors[role];
  }

  return {
    sessionId,
    task,
    runDir,
    generatedAt: new Date(now).toISOString(),
    models: { researcher: models.researcher ?? null, advisor: models.advisor ?? null },
    outcome: {
      state: snapshot.state ?? null,
      terminalReason: snapshot.terminalReason ?? null,
      startedAt: sessionStarted !== null ? new Date(sessionStarted).toISOString() : null,
      finishedAt: sessionFinished !== null ? new Date(sessionFinished).toISOString() : null,
    },
    duration: {
      totalMs,
      sessionMs,
      byRoleMs,
    },
    tokens: {
      total: tokens,
      byRole: {
        researcher: byRole.researcher.tokens,
        advisor: byRole.advisor.tokens,
      },
    },
    turns: {
      researcher: turns.researcher,
      advisor: turns.advisor,
      total: turns.researcher + turns.advisor,
    },
    messages,
    toolCalls,
    handoffs: {
      total: Number.isFinite(snapshot.handoffs) ? snapshot.handoffs : handoffsOut,
      out: handoffsOut,
      in: handoffsIn,
      byKind: handoffsByKind,
    },
    goals: {
      count: goalList.length,
      ids: goalList,
      researcherSteps: Number.isFinite(snapshot.researcherSteps) ? snapshot.researcherSteps : null,
      currentGoalId: snapshot.currentGoalId ?? null,
    },
    humanDecisions: {
      count: decisions.length,
      actions: decisions.map((d) => d?.action ?? "unknown"),
    },
    recovery,
    subagents: {
      count: subagentIds.length,
      byAgent: subagents,
    },
    skills: {
      count: skillNames.length,
      names: skillNames,
    },
    artifacts: {
      count: artifactFiles.length,
      totalBytes: artifactsBytes,
      goalsMdBytes: readSize(path.join(researcherSandbox, "GOALS.md")),
      files: artifactFiles,
    },
    errors: Object.keys(errors).length ? errors : {},
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTokens(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/** Human-readable one-liner block printed to the console. */
export function renderStatsSummary(stats) {
  const t = stats.tokens.total;
  const lines = [
    `[research-loop] stats: ${stats.outcome.state ?? "?"} (${stats.outcome.terminalReason || "n/a"})`,
    `[research-loop]   duration: ${formatDuration(stats.duration.totalMs)}`,
    `[research-loop]   tokens: input ${formatTokens(t.input)}, output ${formatTokens(t.output)}, ` +
      `reasoning ${formatTokens(t.reasoning)}, cacheRead ${formatTokens(t.cacheRead)} ` +
      `(total ${formatTokens(t.totalTokens)})`,
    `[research-loop]   turns: researcher ${stats.turns.researcher}, advisor ${stats.turns.advisor}; ` +
      `tool calls: researcher ${stats.toolCalls.researcher.total}, advisor ${stats.toolCalls.advisor.total}`,
    `[research-loop]   handoffs: ${stats.handoffs.total}; goals: ${stats.goals.count}; ` +
      `skills: ${stats.skills.count}; artifacts: ${stats.artifacts.count}` +
      (stats.subagents?.count ? `; subagents: ${stats.subagents.count}` : ""),
  ];
  const retries = [];
  for (const role of ROLES) {
    const r = stats.recovery[role];
    const active = Object.entries(r)
      .filter(([k, v]) => k !== "warnings" && k !== "errorTurns" && Number(v) > 0)
      .map(([k, v]) => `${k}=${v}`);
    if (r.warnings) active.push(`warnings=${r.warnings}`);
    if (active.length) retries.push(`${role}: ${active.join(", ")}`);
  }
  if (retries.length) lines.push(`[research-loop]   recovery: ${retries.join(" | ")}`);
  return lines.join("\n");
}
