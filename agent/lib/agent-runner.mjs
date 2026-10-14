/**
 * AgentSession: a long-lived pi-agent-core Agent plus the retry/compaction
 * driver and the handoff protocol.
 *
 * One session spans the whole run for a single role. Between phases the Agent
 * is NOT recreated, so workspace state and (importantly) conversation
 * continuity persist. A new user prompt is appended on each inbound handoff.
 */
import { Agent } from "@earendil-works/pi-agent-core";

import {
  canContinueFromMessages,
  shouldRetryAbortedTurn,
  shouldRetryContextOverflow,
  shouldRetryRateLimitTurn,
  shouldRetryTransientProviderTurn,
  trimToLastConsistentMessages,
} from "./abort-retry.mjs";
import {
  buildCompactionUserMessage,
  buildSandboxSnapshot,
  compactMessages,
  isCompactionTrigger,
  lastAssistantErrorDetail,
  lastAssistantReasoning,
  lastAssistantStopReason,
} from "./context-compaction.mjs";
import { hasUnlimitedMaxTokens, stripMaxTokensOnPayload } from "./model-providers.mjs";
import fs from "node:fs";
import path from "node:path";
import { providerRequestHeaders } from "./client-identity.mjs";
import { streamAgentEvent } from "./partial-stream.mjs";

const DEFAULT_MAX_ABORT_RETRIES = 5;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 10;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60000;
const DEFAULT_MAX_PROVIDER_ERROR_RETRIES = 3;
const DEFAULT_PROVIDER_ERROR_BACKOFF_MS = 5000;

/** Collect text blocks from the last assistant message. */
function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const parts = (msg.content || [])
      .filter((c) => c?.type === "text" && c.text)
      .map((c) => c.text);
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * @param {object} opts
 * @param {"researcher"|"advisor"} opts.role
 * @param {import("@earendil-works/pi-ai").Model<any>} opts.model
 * @param {import("@earendil-works/pi-ai").Models} opts.models
 * @param {string} opts.systemPrompt
 * @param {Array<object>} opts.tools
 * @param {string} opts.sandbox
 * @param {object} opts.transcript createTranscriptWriter() instance
 * @param {string} [opts.thinkingLevel]
 * @param {number} [opts.maxTurnsPerPhase]
 * @param {number} [opts.abortTimeoutMs]
 */
function newPhaseRetries() {
  return { abort: 0, rateLimit: 0, contextOverflow: 0, providerError: 0, proximity: 0 };
}

export class AgentSession {
  constructor(opts) {
    this.role = opts.role;
    this.model = opts.model;
    this.models = opts.models;
    this.systemPrompt = opts.systemPrompt;
    this.tools = opts.tools;
    this.sandbox = opts.sandbox;
    this.goalsPath = opts.goalsPath || null;
    this.transcript = opts.transcript;
    // Optional live display of in-progress output (see partial-stream.mjs).
    this.partialStreamer = opts.partialStreamer || null;
    // Provider-facing session id (e.g. OpenCode's x-opencode-session).
    this.clientSessionId = opts.clientSessionId || null;
    this.thinkingLevel = opts.thinkingLevel || "off";
    // 0 = unlimited turns per phase.
    this.maxTurnsPerPhase = opts.maxTurnsPerPhase ?? 1000;
    // 0 = no per-attempt abort (run may continue indefinitely; monitor via UI).
    this.abortTimeoutMs = opts.abortTimeoutMs ?? 0;
    this.maxAbortRetries = opts.maxAbortRetries ?? DEFAULT_MAX_ABORT_RETRIES;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.rateLimitBackoffMs = opts.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.maxContextOverflowRetries = opts.maxContextOverflowRetries ?? 3;
    // Safety cap on proximity-triggered compactions within a run, so a prompt
    // that cannot be shrunk enough does not compact forever.
    this.maxProximityCompactions = opts.maxProximityCompactions ?? 20;
    this.maxProviderRetries = opts.maxProviderRetries ?? 4;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 60000;
    // Transient provider/transport errors (e.g. "terminated") recovered by
    // trimming the failed turn and continuing from the last consistent point.
    this.maxProviderErrorRetries = opts.maxProviderErrorRetries ?? DEFAULT_MAX_PROVIDER_ERROR_RETRIES;
    this.providerErrorBackoffMs =
      opts.providerErrorBackoffMs ?? DEFAULT_PROVIDER_ERROR_BACKOFF_MS;
    // 0 = no hard per-phase wall clock.
    this.phaseTimeoutMs = opts.phaseTimeoutMs ?? 0;
    // Per-attempt window: each aborted attempt is retried with a fresh window
    // (bounded by phaseTimeoutMs and maxAbortRetries).
    this.abortTimer = null;
    this.phaseStart = 0;
    // Effective per-model limits (used for proactive compaction / clamping).
    this.contextWindow = Number(opts.model?.contextWindow) || 0;
    this.maxOutputTokens = Number(opts.model?.maxTokens) || 0;
    this.lastInputTokens = 0;

    this.totalTurns = 0;
    this.phaseTurns = 0;
    this.compacted = 0;
    this.lengthStops = 0;
    this.abortRetries = 0;
    this.rateLimitRetries = 0;
    this.contextOverflowRetries = 0;
    this.providerErrorRetries = 0;
    this.proximityCompactions = 0;
    // Retry/compaction caps apply per phase; the totals above are for stats.
    this.phaseRetries = newPhaseRetries();
    this.agentWarnings = [];
    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

    /** @type {{ pendingHandoff: { kind: string, goalId: string|null, payload: object }|null }} */
    this.controlState = opts.controlState || { pendingHandoff: null };

    this.agent = null;
  }

  makeAgent() {
    const session = this;
    return new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        tools: this.tools,
      },
      streamFn: (model, context, options) => {
        // Inject a provider-level retry policy (pi-ai defaults to maxRetries=0,
        // which makes transient 5xx/408/network errors fatal). Callers can
        // still override per call.
        const merged = { ...options };
        if (merged.maxRetries === undefined) merged.maxRetries = session.maxProviderRetries;
        if (merged.maxRetryDelayMs === undefined) merged.maxRetryDelayMs = session.maxRetryDelayMs;
        // With an "unlimited" model, pi-ai would force max_tokens=1 when the
        // context window is unknown; drop the cap so the provider decides.
        if (hasUnlimitedMaxTokens(model)) {
          merged.onPayload = stripMaxTokensOnPayload(merged.onPayload);
        }
        // Provider-required identification (OpenCode session/client headers).
        const extraHeaders = providerRequestHeaders(model, session.clientSessionId);
        if (Object.keys(extraHeaders).length) {
          merged.headers = { ...extraHeaders, ...merged.headers };
        }
        return session.models.streamSimple(model, context, merged);
      },
      toolExecution: "sequential",
      shouldStopAfterTurn: () => {
        if (session.controlState.pendingHandoff) return true;
        const stop = lastAssistantStopReason(session.agent?.state?.messages || []);
        if (isCompactionTrigger(stop) || String(stop).toLowerCase() === "aborted") return true;
        // Stop mid-phase when the prompt approaches the context window, so the
        // runner can compact before the next request instead of letting the
        // provider reject it.
        if (session.#shouldStopToCompact()) return true;
        if (session.maxTurnsPerPhase > 0 && session.phaseTurns >= session.maxTurnsPerPhase) {
          return true;
        }
        return false;
      },
    });
  }

  wire(agent) {
    const session = this;
    agent.subscribe((event) => {
      streamAgentEvent(session.partialStreamer, event);
      if (event.type === "turn_start") {
        session.phaseTurns += 1;
        session.totalTurns += 1;
      }
      if (event.type === "message_end") {
        session.transcript.writeMessage(event.message);
        const msg = event.message;
        if (msg?.role === "assistant" && msg.usage) {
          session.tokens.input += msg.usage.input || 0;
          session.tokens.output += msg.usage.output || 0;
          session.tokens.cacheRead += msg.usage.cacheRead || 0;
          session.tokens.cacheWrite += msg.usage.cacheWrite || 0;
          session.tokens.reasoning += msg.usage.reasoning || 0;
          // The effective prompt size is the full prompt: uncached input plus
          // the cached read/write portions (pi-ai defines prompt_tokens this
          // way). Using only `input` undercounts badly when prompt caching is
          // active (e.g. `input` is a tiny delta while `cacheRead` holds the
          // bulk of the prompt), which stops proactive compaction from firing.
          const promptTokens =
            (msg.usage.input || 0) +
            (msg.usage.cacheRead || 0) +
            (msg.usage.cacheWrite || 0);
          if (promptTokens > 0) session.lastInputTokens = promptTokens;
        }
        if (isCompactionTrigger(msg?.stopReason)) session.lengthStops += 1;
      }
    });
  }

  async start() {
    this.agent = this.makeAgent();
    this.wire(this.agent);
  }

  #phaseBudgetExceeded() {
    return (
      this.phaseTimeoutMs > 0 &&
      this.phaseStart > 0 &&
      Date.now() - this.phaseStart > this.phaseTimeoutMs
    );
  }

  #armPhaseTimer() {
    this.#clearPhaseTimer();
    if (!(this.abortTimeoutMs > 0)) return;
    this.abortTimer = setTimeout(() => {
      try {
        this.agent.abort();
      } catch {
        // ignore
      }
    }, this.abortTimeoutMs);
  }

  #clearPhaseTimer() {
    if (this.abortTimer) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }
  }

  async #maybeRetryAbort(caughtError = null) {
    const msgs = this.agent?.state?.messages || [];
    if (!shouldRetryAbortedTurn(msgs, caughtError)) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping abort retry");
      return false;
    }
    if (this.maxTurnsPerPhase > 0 && this.phaseTurns >= this.maxTurnsPerPhase) return false;
    if (this.phaseRetries.abort >= this.maxAbortRetries) {
      this.agentWarnings.push(`abort retry cap (${this.maxAbortRetries})`);
      return false;
    }
    try {
      await this.agent.waitForIdle();
    } catch {
      // ignore
    }
    const trimmed = trimToLastConsistentMessages(this.agent.state.messages);
    if (!canContinueFromMessages(trimmed)) {
      this.agentWarnings.push("abort retry skipped: no consistent continue point");
      return false;
    }
    this.abortRetries += 1;
    this.phaseRetries.abort += 1;
    const warning = `abort-retry:${this.abortRetries} at turn ${this.totalTurns}`;
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    await this.#continueFromTrimmed(trimmed);
    return true;
  }

  async #maybeRetryRateLimit(caughtError = null) {
    const msgs = this.agent?.state?.messages || [];
    if (!shouldRetryRateLimitTurn(msgs, caughtError)) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping rate-limit retry");
      return false;
    }
    if (this.maxTurnsPerPhase > 0 && this.phaseTurns >= this.maxTurnsPerPhase) return false;
    if (this.phaseRetries.rateLimit >= this.maxRateLimitRetries) {
      this.agentWarnings.push(`rate-limit retry cap (${this.maxRateLimitRetries})`);
      return false;
    }
    try {
      await this.agent.waitForIdle();
    } catch {
      // ignore
    }
    const trimmed = trimToLastConsistentMessages(this.agent.state.messages);
    if (!canContinueFromMessages(trimmed)) {
      this.agentWarnings.push("rate-limit retry skipped: no consistent continue point");
      return false;
    }
    this.rateLimitRetries += 1;
    this.phaseRetries.rateLimit += 1;
    const waitMs = this.rateLimitBackoffMs;
    const warning =
      `rate-limit-retry:${this.rateLimitRetries} after HTTP 429 at turn ${this.totalTurns}` +
      (waitMs > 0 ? `; waiting ${Math.round(waitMs / 1000)}s` : "");
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.#continueFromTrimmed(trimmed);
    return true;
  }

  async #continueFromTrimmed(trimmed) {
    const continueFrom = async (target) => {
      target.state.messages = trimmed;
      await target.continue();
    };
    try {
      await continueFrom(this.agent);
    } catch {
      this.agent = this.makeAgent();
      this.wire(this.agent);
      await continueFrom(this.agent);
    }
    // Fresh per-attempt window for the continued work.
    this.#armPhaseTimer();
  }

  /** Replace the agent with a fresh one holding compacted history (no prompt). */
  #compactAgentHistory(messages) {
    const compacted = compactMessages(messages);
    this.compacted += 1;
    this.agent = this.makeAgent();
    this.wire(this.agent);
    this.agent.state.messages = compacted;
    this.lastInputTokens = 0;
    return true;
  }

  /**
   * The provider rejected a request because input + max output exceeded the
   * context window (common when a model's real window is larger/smaller than
   * configured). Trim the failed turn, compact, and continue.
   */
  async #maybeRetryContextOverflow(caughtError = null) {
    const msgs = this.agent?.state?.messages || [];
    if (!shouldRetryContextOverflow(msgs, caughtError)) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping context-overflow retry");
      return false;
    }
    if (this.phaseRetries.contextOverflow >= this.maxContextOverflowRetries) {
      this.agentWarnings.push(`context-overflow retry cap (${this.maxContextOverflowRetries})`);
      return false;
    }
    try {
      await this.agent.waitForIdle();
    } catch {
      // ignore
    }
    const trimmed = trimToLastConsistentMessages(msgs);
    if (!canContinueFromMessages(trimmed)) {
      this.agentWarnings.push("context-overflow retry skipped: no consistent continue point");
      return false;
    }
    this.contextOverflowRetries += 1;
    this.phaseRetries.contextOverflow += 1;
    const warning =
      `context-overflow-retry:${this.contextOverflowRetries} at turn ${this.totalTurns}; ` +
      "compacting history";
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    this.#compactAgentHistory(trimmed);
    await this.agent.continue();
    this.#armPhaseTimer();
    return true;
  }

  /**
   * The provider/transport dropped the stream mid-turn (e.g. undici
   * "terminated"). Trim the failed turn and continue from the last consistent
   * point, with a short backoff, up to a bounded cap.
   */
  async #maybeRetryProviderError(caughtError = null) {
    const msgs = this.agent?.state?.messages || [];
    if (!shouldRetryTransientProviderTurn(msgs, caughtError)) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping provider-error retry");
      return false;
    }
    if (this.maxTurnsPerPhase > 0 && this.phaseTurns >= this.maxTurnsPerPhase) return false;
    if (this.phaseRetries.providerError >= this.maxProviderErrorRetries) {
      this.agentWarnings.push(`provider-error retry cap (${this.maxProviderErrorRetries})`);
      return false;
    }
    try {
      await this.agent.waitForIdle();
    } catch {
      // ignore
    }
    const trimmed = trimToLastConsistentMessages(this.agent.state.messages);
    if (!canContinueFromMessages(trimmed)) {
      this.agentWarnings.push("provider-error retry skipped: no consistent continue point");
      return false;
    }
    this.providerErrorRetries += 1;
    this.phaseRetries.providerError += 1;
    const detail = lastAssistantErrorDetail(this.agent.state.messages)?.errorMessage || "unknown";
    const waitMs = this.providerErrorBackoffMs;
    const warning =
      `provider-error-retry:${this.providerErrorRetries} after transient provider failure ` +
      `(${detail}) at turn ${this.totalTurns}` +
      (waitMs > 0 ? `; waiting ${Math.round(waitMs / 1000)}s` : "");
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.#continueFromTrimmed(trimmed);
    return true;
  }

  /** Output-token headroom reserved for the next request when compacting. */
  #outputReserve() {
    return (this.maxOutputTokens || 8192) + 4096;
  }

  /**
   * Whether the prompt is close enough to the context window that we should
   * stop the phase and compact. Only applies when a context window is known
   * and the provider has actually reported a prompt size.
   */
  #shouldStopToCompact() {
    if (this.controlState.pendingHandoff) return false;
    if (!(this.contextWindow > 0) || !(this.lastInputTokens > 0)) return false;
    return this.lastInputTokens + this.#outputReserve() > this.contextWindow;
  }

  /** Compact before prompting if the last reported prompt is near the window. */
  #maybeCompactProactively() {
    if (!this.#shouldStopToCompact()) return;
    const reserve = this.#outputReserve();
    const warning =
      `proactive-compaction: last prompt ~${this.lastInputTokens} tokens; ` +
      `context window ${this.contextWindow}, reserve ${reserve}`;
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    this.#compactAgentHistory(this.agent.state.messages);
  }

  /**
   * Replace history with a compacted copy and continue the current task.
   * @param {string} stopReason
   * @param {string} label short reason recorded in the warning
   */
  async #compactNow(stopReason, label) {
    try {
      await this.agent.waitForIdle();
    } catch {
      // ignore
    }
    const before = this.agent.state.messages;
    const partialReasoning = lastAssistantReasoning(before);
    const compactedMsgs = compactMessages(before);
    this.compacted += 1;
    const warning = `compaction:${this.compacted} (${label}) at turn ${this.totalTurns}`;
    this.agentWarnings.push(warning);
    this.transcript.write("system", { content: warning });
    const compactionText = buildCompactionUserMessage({
      compactionIndex: this.compacted,
      stopReason,
      sandboxSnapshot: buildSandboxSnapshot(this.sandbox, fs, path, this.goalsPath),
      partialReasoning,
    });
    this.agent = this.makeAgent();
    this.wire(this.agent);
    this.agent.state.messages = compactedMsgs;
    await this.agent.prompt(compactionText);
    this.#armPhaseTimer();
    return true;
  }

  async #maybeCompact() {
    const stopReason = lastAssistantStopReason(this.agent?.state?.messages || []);
    if (!isCompactionTrigger(stopReason)) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping compaction");
      return false;
    }
    if (this.maxTurnsPerPhase > 0 && this.phaseTurns >= this.maxTurnsPerPhase) return false;
    return this.#compactNow(stopReason, "length");
  }

  /**
   * Compact mid-phase when the prompt is approaching the context window but the
   * provider did not emit a `length` stop (e.g. servers that reject an
   * over-long request instead of truncating it).
   */
  async #maybeCompactOnProximity() {
    if (!this.#shouldStopToCompact()) return false;
    if (this.#phaseBudgetExceeded()) {
      this.agentWarnings.push("phase budget exceeded; skipping proximity compaction");
      return false;
    }
    if (this.maxTurnsPerPhase > 0 && this.phaseTurns >= this.maxTurnsPerPhase) return false;
    if (this.phaseRetries.proximity >= this.maxProximityCompactions) {
      this.agentWarnings.push(`proximity-compaction cap (${this.maxProximityCompactions})`);
      return false;
    }
    this.proximityCompactions += 1;
    this.phaseRetries.proximity += 1;
    const stopReason = lastAssistantStopReason(this.agent?.state?.messages || []) || "proximity";
    return this.#compactNow(stopReason, "context-proximity");
  }

  async #recoverTurns(caughtError = null) {
    let retried = false;
    let error = caughtError;
    // Alternate recovery actions until none applies. Each action continues the
    // agent loop; when it stops again we re-evaluate from the top.
    for (let guard = 0; guard < 100; guard += 1) {
      if (await this.#maybeRetryAbort(error)) {
        retried = true;
        error = null;
        continue;
      }
      if (await this.#maybeRetryRateLimit(error)) {
        retried = true;
        error = null;
        continue;
      }
      if (await this.#maybeRetryContextOverflow(error)) {
        retried = true;
        error = null;
        continue;
      }
      if (await this.#maybeRetryProviderError(error)) {
        retried = true;
        error = null;
        continue;
      }
      if (await this.#maybeCompact()) {
        retried = true;
        error = null;
        continue;
      }
      if (await this.#maybeCompactOnProximity()) {
        retried = true;
        error = null;
        continue;
      }
      break;
    }
    return retried;
  }

  /**
   * Run one phase: prompt the agent and recover provider failures.
   * @returns {Promise<{ error: string|null, stopReason: string|null }>}
   */
  async runPrompt(text) {
    this.phaseTurns = 0;
    this.phaseRetries = newPhaseRetries();
    this.controlState.pendingHandoff = null;
    this.phaseStart = Date.now();
    this.#maybeCompactProactively();
    this.#armPhaseTimer();
    let promptError = null;
    try {
      await this.agent.prompt(text);
      if (await this.#recoverTurns(null)) promptError = null;
    } catch (e) {
      const caught = e?.message || String(e);
      try {
        if (await this.#recoverTurns(caught)) {
          promptError = null;
        } else {
          promptError = caught;
        }
      } catch (retryErr) {
        promptError = retryErr?.message || String(retryErr);
      }
    } finally {
      this.#clearPhaseTimer();
    }
    return {
      error: promptError,
      stopReason: lastAssistantStopReason(this.agent?.state?.messages || []),
    };
  }

  hasPendingHandoff() {
    return Boolean(this.controlState.pendingHandoff);
  }

  /**
   * Produce the outbound envelope from the pending handoff (must be called
   * after runPrompt, before the next runPrompt).
   */
  takeHandoff() {
    const pending = this.controlState.pendingHandoff;
    if (!pending) return null;
    const text = lastAssistantText(this.agent?.state?.messages || []);
    this.controlState.pendingHandoff = null;
    return {
      role: this.role,
      kind: pending.kind,
      goalId: pending.goalId ?? null,
      text,
      payload: pending.payload ?? {},
      ts: Date.now(),
    };
  }

  abort() {
    try {
      this.agent?.abort();
    } catch {
      // ignore
    }
  }

  stats() {
    return {
      role: this.role,
      turns: this.totalTurns,
      tokens: this.tokens,
      compacted: this.compacted,
      proximityCompactions: this.proximityCompactions,
      lengthStops: this.lengthStops,
      abortRetries: this.abortRetries,
      rateLimitRetries: this.rateLimitRetries,
      contextOverflowRetries: this.contextOverflowRetries,
      providerErrorRetries: this.providerErrorRetries,
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      warnings: this.agentWarnings,
    };
  }
}
