/**
 * Host-side credential resolution, ported from biodivine-model-sniffer's
 * retrieve/job.py. Priority:
 *   1. provider.apiKeyEnv from pi_config.json
 *   2. built-in provider env var (e.g. ANTHROPIC_API_KEY)
 *   3. Pi auth.json (~/.pi/agent/auth.json or PI_AUTH_FILE / PI_AUTH_PATH)
 *
 * Providers not listed in pi_config.json fall back to pi-ai's built-in catalog
 * (e.g. `opencode-go`, `anthropic`), authenticated by auth.json or the
 * provider's standard env var (e.g. OPENCODE_API_KEY).
 *
 * localhost base URLs are rewritten to host.docker.internal for container access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildModels, parseModelSpec } from "../agent/lib/model-providers.mjs";

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

function readAuthEntry(providerId) {
  const file = authPath();
  if (!file) return null;
  try {
    return authEntryApiKey(JSON.parse(fs.readFileSync(file, "utf8"))?.[providerId]);
  } catch {
    return null;
  }
}

/**
 * Credentials for a model from pi-ai's built-in provider catalog (optionally
 * extended by pi_config.json, see builtinExtensionModels). `provider` is null:
 * the agent resolves the model from the same catalog; a model that only exists
 * through pi_config.json is passed along as `extraModel`.
 *
 * @returns {Promise<{ providerId, apiKey, provider: null, builtin: true, extraModel? } | { error: string }>}
 */
async function resolveBuiltinCredentials(providerId, modelId, configPath) {
  const { models } = buildModels({ configPath });
  if (!models.getProvider(providerId)) {
    return { error: `unknown provider '${providerId}' (not in pi_config.json or pi-ai's catalog)` };
  }
  const model = models.getModel(providerId, modelId);
  if (!model) {
    const known = models.getModels(providerId).map((m) => m.id);
    return {
      error:
        `model '${modelId}' is not in pi-ai's '${providerId}' catalog. Known: ${known.join(", ")}. ` +
        `To use a newer model, add to pi_config.json: ` +
        `{ "id": "${providerId}", "models": [{ "id": "${modelId}", "like": "<similar known model>" }] }`,
    };
  }
  const apiKey = (await models.getAuth(model))?.auth?.apiKey;
  if (!apiKey) {
    return { error: `no API key for provider '${providerId}' (set its env var, e.g. OPENCODE_API_KEY, or auth.json)` };
  }
  const { models: plain } = buildModels({});
  const extraModel = plain.getModel(providerId, modelId) ? undefined : model;
  return { providerId, apiKey, provider: null, builtin: true, extraModel };
}

/**
 * @param {string} model "provider:model::effort"
 * @param {string|null} configPath
 * @returns {Promise<{ provider: object|null, apiKey: string, providerId: string, builtin?: boolean, extraModel?: object } | { error: string } | null>}
 */
export async function resolveCredentials(model, configPath) {
  if (!String(model).includes(":")) return null;
  const providerId = String(model).split(":", 1)[0];
  const config = loadConfig(configPath);
  const provider = (config.providers || []).find((p) => p && p.id === providerId) || null;
  if (!provider || !provider.baseUrl) {
    const { modelId } = parseModelSpec(model);
    return resolveBuiltinCredentials(providerId, modelId, configPath);
  }

  let apiKey = null;
  const apiKeyEnv = provider?.apiKeyEnv;
  if (apiKeyEnv && process.env[apiKeyEnv]) {
    apiKey = process.env[apiKeyEnv];
  }
  if (!apiKey) {
    const envName = PROVIDER_ENV_MAP[providerId];
    if (envName && process.env[envName]) apiKey = process.env[envName];
  }
  if (!apiKey) apiKey = readAuthEntry(providerId);

  if (!apiKey) return null;
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

export { PROVIDER_ENV_MAP };
