/**
 * Host-side credential resolution, ported from biodivine-model-sniffer's
 * retrieve/job.py. Priority:
 *   1. provider.apiKeyEnv from pi_config.json
 *   2. built-in provider env var (e.g. ANTHROPIC_API_KEY)
 *   3. Pi auth.json (~/.pi/agent/auth.json or PI_AUTH_FILE / PI_AUTH_PATH)
 *
 * localhost base URLs are rewritten to host.docker.internal for container access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROVIDER_ENV_MAP = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
};

function authEntryApiKey(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    for (const field of ["key", "apiKey"]) {
      const c = value[field];
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  return null;
}

function authPath() {
  for (const raw of [
    process.env.PI_AUTH_FILE,
    process.env.PI_AUTH_PATH,
    path.join(os.homedir(), ".pi", "agent", "auth.json"),
  ]) {
    if (raw && fs.existsSync(raw)) return raw;
  }
  return null;
}

function replaceLocalhost(url) {
  return String(url || "")
    .replaceAll("localhost", "host.docker.internal")
    .replaceAll("127.0.0.1", "host.docker.internal");
}

export function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return { providers: [] };
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { providers: [] };
  }
}

/**
 * @param {string} model "provider:model::effort"
 * @param {string|null} configPath
 * @returns {{ provider: object, apiKey: string, providerId: string } | null}
 */
export function resolveCredentials(model, configPath) {
  if (!String(model).includes(":")) return null;
  const providerId = String(model).split(":", 1)[0];
  const config = loadConfig(configPath);
  const provider = (config.providers || []).find((p) => p && p.id === providerId) || null;

  let apiKey = null;
  const apiKeyEnv = provider?.apiKeyEnv;
  if (apiKeyEnv && process.env[apiKeyEnv]) {
    apiKey = process.env[apiKeyEnv];
  }
  if (!apiKey) {
    const envName = PROVIDER_ENV_MAP[providerId];
    if (envName && process.env[envName]) apiKey = process.env[envName];
  }
  if (!apiKey) {
    const file = authPath();
    if (file) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        apiKey = authEntryApiKey(data?.[providerId]);
      } catch {
        // ignore
      }
    }
  }

  if (!provider || !apiKey) return null;
  return { providerId, apiKey, provider };
}

/** Rewrite localhost base URLs to host.docker.internal for container access. */
export function providerForDocker(provider) {
  return { ...provider, baseUrl: replaceLocalhost(provider.baseUrl) };
}

function firstPositive(entry, keys) {
  for (const k of keys) {
    const v = entry?.[k];
    if (typeof v === "number" && v > 0) return v;
  }
  return undefined;
}

/**
 * Best-effort discovery of a model's context/output limits from the provider's
 * OpenAI-compatible `/models` endpoint (LiteLLM, vLLM, OpenRouter, ...).
 * Returns {} on any failure; never throws.
 *
 * @returns {Promise<{ contextWindow?: number, maxTokens?: number }>}
 */
export async function discoverModelLimits(provider, modelId, apiKey, { timeoutMs = 8000 } = {}) {
  const base = String(provider?.baseUrl || "").replace(/\/$/, "");
  if (!base) return {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    if (!res.ok) return {};
    const body = await res.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const wanted = String(modelId);
    const entry =
      list.find((m) => m?.id === wanted) ||
      list.find((m) => typeof m?.id === "string" && m.id.endsWith(`/${wanted}`)) ||
      list.find((m) => typeof m?.id === "string" && m.id === provider?.id);
    if (!entry) return {};
    const contextWindow =
      firstPositive(entry, ["max_input_tokens", "max_model_len", "context_length", "context_window", "max_context_tokens"]) ??
      firstPositive(entry?.top_provider, ["context_length"]) ??
      firstPositive(entry, ["max_tokens"]);
    const maxTokens =
      firstPositive(entry, ["max_output_tokens", "max_completion_tokens"]) ??
      firstPositive(entry?.top_provider, ["max_completion_tokens"]);
    return { contextWindow, maxTokens };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** A provider-free spec (built-in provider available in pi-ai's builtinModels). */
export function hasBuiltinProvider(model) {
  const id = String(model).split(":", 1)[0];
  return Object.prototype.hasOwnProperty.call(PROVIDER_ENV_MAP, id);
}

export { PROVIDER_ENV_MAP };
