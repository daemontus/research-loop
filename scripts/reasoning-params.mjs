#!/usr/bin/env node
/**
 * Show exactly which reasoning parameters pi-ai sends to the provider for each
 * thinking level, for the models in pi_config.json (or the given specs).
 *
 *   node scripts/reasoning-params.mjs [--config pi_config.json] [provider:model ...]
 *
 * Builds each request with pi-ai and captures it in its payload hook, which
 * throws before anything goes over the network; no API key is needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildModels, THINKING_LEVELS } from "../agent/lib/model-providers.mjs";

/** Request fields that carry reasoning settings (whatever the provider style). */
const REASONING_FIELDS = [
  "reasoning_effort",
  "reasoning",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
  "chat_template_args",
  "thinking_token_budget",
  "thinking_budget",
  "thinking_budget_tokens",
];

/**
 * @param {string} configPath
 * @param {string[]} [specs] provider:model specs (default: every model in the config)
 * @returns {Promise<Array<{ spec: string, error?: string, reasoning?: boolean, params?: Record<string, object|null> }>>}
 */
export async function reasoningParams(configPath, specs = []) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const saved = { ...process.env };
  for (const p of cfg.providers || []) process.env[p.apiKeyEnv || `${String(p.id).toUpperCase()}_API_KEY`] ||= "x";
  process.env.OPENCODE_API_KEY ||= "x";
  try {
    const { models } = buildModels({ configPath });
    const wanted = specs.length
      ? specs
      : (cfg.providers || []).flatMap((p) => (p.models || []).map((m) => `${p.id}:${m.id}`));
    const out = [];
    for (const spec of wanted) {
      const sep = spec.indexOf(":");
      const model = sep > 0 ? models.getModel(spec.slice(0, sep), spec.slice(sep + 1).replace(/::.*$/, "")) : null;
      if (!model) {
        out.push({ spec, error: "model not found" });
        continue;
      }
      const params = {};
      for (const level of THINKING_LEVELS) {
        let captured = null;
        try {
          const stream = models.streamSimple(
            model,
            { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
            {
              apiKey: "x",
              // As the agent does: "off" means no reasoning option at all.
              reasoning: level === "off" ? undefined : level,
              maxRetries: 0,
              onPayload: (body) => {
                captured = Object.fromEntries(REASONING_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
                throw new Error("captured");
              },
            },
          );
          for await (const _ of stream) {
            // drain until the hook aborts the request
          }
        } catch {
          // expected
        }
        params[level] = captured;
      }
      out.push({ spec, reasoning: Boolean(model.reasoning), params });
    }
    return out;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pi_config.json");
  const ci = args.indexOf("--config");
  if (ci !== -1) {
    configPath = path.resolve(args[ci + 1]);
    args.splice(ci, 2);
  }
  for (const row of await reasoningParams(configPath, args)) {
    if (row.error) {
      console.log(`${row.spec}: ${row.error}`);
      continue;
    }
    console.log(`${row.spec}${row.reasoning ? "" : "  (reasoning: false — nothing is ever sent)"}`);
    for (const [level, p] of Object.entries(row.params)) {
      const shown = p === null ? "(request not built)" : Object.keys(p).length ? JSON.stringify(p) : "(no reasoning field)";
      console.log(`  ${level.padEnd(8)} ${shown}`);
    }
  }
}
