/**
 * Model/provider construction, shared by both agent roles.
 *
 * Supports the same provider configuration format as biodivine-model-sniffer's
 * `pi_config.json` (providers[].{id,name,baseUrl,apiKeyEnv,models[]}) plus
 * credentials resolved from:
 *   1. an explicit `provider` + `apiKey` passed in the job (reference style)
 *   2. the `apiKeyEnv` environment variable in the config
 *   3. Pi's auth.json (~/.pi/agent/auth.json, or PI_AUTH_FILE / PI_AUTH_PATH)
 *
 * `parseModelSpec("provider:model::effort")` handles the optional trailing
 * reasoning-effort component (see pi-retrieve / pi-judge).
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseModelSpec(spec) {
  const raw = String(spec || "");
  const sep = raw.indexOf(":");
  if (sep === -1) {
    return { error: `model must be 'provider:model', got '${raw}'` };
  }
  const providerId = raw.slice(0, sep);
  const rest = raw.slice(sep + 1);
  const effortSep = rest.lastIndexOf("::");
  const modelId = effortSep === -1 ? rest : rest.slice(0, effortSep);
  const effort = effortSep === -1 ? null : rest.slice(effortSep + 2) || null;
  return { providerId, modelId, effort };
}

export function makeCredentialStore(credentials) {
  const data = new Map();
  for (const [providerId, value] of Object.entries(credentials || {})) {
    const key = typeof value === "string" ? value : value?.key ?? value?.apiKey;
    data.set(providerId, { type: "api_key", key, env: value?.env || {} });
  }
  return {
    read: async (providerId) => data.get(providerId),
    list: async () =>
      [...data.entries()].map(([providerId, cred]) => ({
        providerId,
        type: cred.type,
      })),
    modify: async (providerId, fn) => {
      data.set(providerId, await fn(data.get(providerId)));
    },
    delete: async (providerId) => {
      data.delete(providerId);
    },
  };
}

function defaultAuthPath() {
  return (
    process.env.PI_AUTH_FILE ||
    process.env.PI_AUTH_PATH ||
    path.join(os.homedir(), ".pi", "agent", "auth.json")
  );
}

function loadAuth(config) {
  const merged = {};
  const requested =
    config?.credentialsFile || process.env.PI_AUTH_FILE || process.env.PI_AUTH_PATH || null;
  const candidates = requested ? [requested] : [defaultAuthPath()];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(candidate, "utf8")));
    } catch {
      // ignore unreadable/invalid auth files
    }
  }
  Object.assign(merged, config?.credentials || {});
  return merged;
}

export function loadProviderConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return { credentials: {}, providers: [] };
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    credentials: raw.credentials || {},
    providers: raw.providers || [],
  };
}

function providerModelsList(providerDef) {
  return (providerDef.models || []).map((m) => {
    // Defaults are "unknown"/"no cap": we do not fabricate limits. A cap is
    // only sent when the user configured one (pi_config.json or CLI) or the
    // provider's /models endpoint reported one (discovery). An unknown
    // contextWindow disables pi-ai's request clamping and proactive
    // compaction; context-overflow 400s are still recovered by compaction.
    const contextWindow = Number(m.contextWindow) > 0 ? Number(m.contextWindow) : 0;
    const maxTokens = Number(m.maxTokens) > 0 ? Number(m.maxTokens) : 0;
    return {
      id: m.id,
      name: m.name || m.id,
      api: "openai-completions",
      provider: providerDef.id,
      baseUrl: providerDef.baseUrl,
      reasoning: m.reasoning || false,
      input: m.input || ["text"],
      cost: {
        input: m.inputCost || 0,
        output: m.outputCost || 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow,
      maxTokens,
    };
  });
}

/**
 * Model definitions that pi_config.json adds to a *built-in* provider (an entry
 * whose id is a catalog provider such as "opencode-go" and that has no
 * `baseUrl`). Lets a newer model be used before pi-ai's catalog knows it:
 * `{ "id": "new-model", "like": "known-model" }` clones a catalog model (api,
 * baseUrl, compat, limits, ...) under the new id; other fields override.
 * Models the catalog already has are skipped. Throws on an unknown `like`.
 *
 * @returns {object[]} full pi-ai model objects
 */
export function builtinExtensionModels(models, providerDef) {
  const builtin = models.getProvider(providerDef?.id);
  if (!builtin || providerDef.baseUrl) return [];
  const catalog = builtin.getModels();
  const extra = [];
  for (const entry of providerDef.models || []) {
    if (!entry?.id || catalog.some((m) => m.id === entry.id)) continue;
    const { like, ...overrides } = entry;
    const template = like ? catalog.find((m) => m.id === like) : null;
    if (!template) {
      throw new Error(
        `pi_config.json: model '${providerDef.id}:${entry.id}' is not in pi-ai's catalog; ` +
          `add "like": "<a ${providerDef.id} catalog model>" to clone its settings`,
      );
    }
    extra.push({ ...template, name: overrides.name || entry.id, ...overrides, provider: builtin.id });
  }
  return extra;
}

/** Add full model definitions to a built-in provider (keeps its catalog). */
export function extendBuiltinProvider(models, providerId, extraModels) {
  const builtin = models.getProvider(providerId);
  if (!builtin || !extraModels?.length) return;
  const extended = Object.create(builtin);
  extended.getModels = () => [...builtin.getModels(), ...extraModels];
  models.setProvider(extended);
}

/**
 * True when the model has no positive output-token cap configured. We treat
 * absence, 0 and negative sentinels (e.g. "-1") as "unlimited".
 */
export function hasUnlimitedMaxTokens(model) {
  return !(Number(model?.maxTokens) > 0);
}

/**
 * Wrap an `onPayload` hook so it strips any response-token cap from the
 * request. pi-ai's `clampMaxTokensToContext` turns a model `maxTokens` of 0
 * into `max_tokens: 1` whenever the context window is unknown, so with an
 * "unlimited" model we must delete the field to let the provider decide.
 *
 * @param {((params: object, model: object) => unknown) | undefined} [existing]
 */
export function stripMaxTokensOnPayload(existing) {
  return async (params, model) => {
    const next = existing ? await existing(params, model) : params;
    const target = next === undefined ? params : next;
    if (target && typeof target === "object") {
      delete target.max_tokens;
      delete target.max_completion_tokens;
    }
    return target;
  };
}

/**
 * Build the Models registry.
 *
 * Credentials are assembled *before* `builtinModels()` is called, because the
 * credential store handed to Models is a snapshot. A custom provider created
 * via `createProvider` resolves its key from that store (stored credential
 * wins, then env), so the job-provided `apiKey` must be present up front.
 *
 * @param {object} opts
 * @param {string|null} [opts.configPath] path to pi_config.json
 * @param {object} [opts.provider] single provider def to inject (reference style)
 * @param {string} [opts.apiKey] api key for opts.provider (or for opts.providerId)
 * @param {string} [opts.providerId] provider the api key belongs to when there is
 *   no provider def (a model from pi-ai's built-in catalog, e.g. `opencode-go`)
 * @param {object[]} [opts.extraModels] full model defs to add to `providerId`'s
 *   built-in catalog (resolved by the orchestrator from pi_config.json)
 * @param {object} [opts.faux]
 */
export function buildModels({
  configPath = null,
  provider = null,
  apiKey = null,
  providerId = null,
  extraModels = null,
  faux = null,
} = {}) {
  const config = loadProviderConfig(configPath);
  const credentials = loadAuth(config);

  const keyOwner = provider?.id || providerId;
  if (keyOwner && apiKey) {
    credentials[keyOwner] = apiKey;
  }
  for (const providerDef of config.providers || []) {
    if (!providerDef?.id) continue;
    if (!credentials[providerDef.id] && providerDef.apiKeyEnv && process.env[providerDef.apiKeyEnv]) {
      credentials[providerDef.id] = process.env[providerDef.apiKeyEnv];
    }
  }

  const models = builtinModels({ credentials: makeCredentialStore(credentials) });

  if (faux) {
    const fauxModels = fauxProvider({ provider: faux.provider || "faux" });
    models.setProvider(fauxModels.provider);
    if (Array.isArray(faux.responses)) {
      fauxModels.setResponses(
        faux.responses.map((r) =>
          typeof r === "string"
            ? fauxAssistantMessage(r)
            : fauxAssistantMessage(r.content, {
                stopReason: r.stopReason,
                errorMessage: r.errorMessage,
              }),
        ),
      );
    }
  }

  const registerProvider = (providerDef) => {
    if (!providerDef?.baseUrl || !providerDef?.id) return;
    const entry = credentials[providerDef.id];
    const key = typeof entry === "string" ? entry : entry?.key ?? entry?.apiKey;
    if (!key) return;
    models.setProvider(
      createProvider({
        id: providerDef.id,
        name: providerDef.name || providerDef.id,
        baseUrl: providerDef.baseUrl,
        auth: {
          apiKey: envApiKeyAuth(providerDef.name || providerDef.id, [
            providerDef.apiKeyEnv || `${providerDef.id.toUpperCase()}_API_KEY`,
          ]),
        },
        models: providerModelsList(providerDef),
        api: openAICompletionsApi(),
      }),
    );
  };

  if (provider) registerProvider(provider);
  for (const providerDef of config.providers || []) {
    if (models.getProvider(providerDef?.id) && !providerDef.baseUrl) {
      extendBuiltinProvider(models, providerDef.id, builtinExtensionModels(models, providerDef));
    } else {
      registerProvider(providerDef);
    }
  }
  if (providerId && extraModels?.length) extendBuiltinProvider(models, providerId, extraModels);

  return { models, credentials };
}

/**
 * Throw if the model's provider has no usable credentials. Prevents a session
 * from starting only to fail (and stall) on the first LLM request.
 */
export async function assertProviderConfigured(models, model) {
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error(
      `Provider '${model.provider}' is not configured for model '${model.id}': ` +
        "no API key found (checked job credentials, provider apiKeyEnv, and env vars).",
    );
  }
  return auth;
}

/**
 * Resolve a model for a spec, returning a structured error instead of throwing.
 */
export function resolveModel(models, spec) {
  const parsed = parseModelSpec(spec);
  if (parsed.error) return { error: parsed.error };
  const model = models.getModel(parsed.providerId, parsed.modelId);
  if (!model) return { error: `model not found: ${spec}` };
  return { model, ...parsed };
}
