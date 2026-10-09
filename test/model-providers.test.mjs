import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProviderConfigured,
  buildModels,
  hasUnlimitedMaxTokens,
  resolveModel,
  stripMaxTokensOnPayload,
} from "../agent/lib/model-providers.mjs";

function providerDef(id) {
  return {
    id,
    name: id,
    baseUrl: "http://localhost:1/v1",
    apiKeyEnv: `${id.toUpperCase()}_KEY`,
    models: [{ id: "m", input: ["text"] }],
  };
}

describe("buildModels credential wiring", () => {
  it("makes the job-provided apiKey available to the custom provider", async () => {
    const { models } = buildModels({ provider: providerDef("zzzprov"), apiKey: "secret-key" });
    const model = models.getModel("zzzprov", "m");
    assert.ok(model, "model should be registered");
    const auth = await models.getAuth(model);
    assert.ok(auth, "provider should be configured");
    assert.equal(auth.auth.apiKey, "secret-key");
  });

  it("does not register a custom provider that has no key", () => {
    delete process.env.ZZZNOKEY_KEY;
    const { models } = buildModels({ provider: providerDef("zzznokey") });
    assert.equal(models.getModel("zzznokey", "m"), undefined);
    assert.ok(resolveModel(models, "zzznokey:m").error);
  });

  it("assertProviderConfigured rejects an unconfigured builtin model", async () => {
    const { models } = buildModels();
    let unconfigured;
    for (const m of models.getModels()) {
      if (!(await models.getAuth(m))) {
        unconfigured = m;
        break;
      }
    }
    if (!unconfigured) return; // every builtin provider happens to be configured here
    await assert.rejects(() => assertProviderConfigured(models, unconfigured), /not configured/);
  });

  it("resolves models and strips the effort suffix", () => {
    const { models } = buildModels({ provider: providerDef("zzzeffort"), apiKey: "k" });
    const r = resolveModel(models, "zzzeffort:m::high");
    assert.equal(r.error, undefined);
    assert.equal(r.model.id, "m");
    assert.equal(r.effort, "high");
  });
});

describe("unlimited maxTokens handling", () => {
  it("treats absence, 0 and negative sentinels as unlimited", () => {
    assert.equal(hasUnlimitedMaxTokens({ maxTokens: 0 }), true);
    assert.equal(hasUnlimitedMaxTokens({ maxTokens: "-1" }), true);
    assert.equal(hasUnlimitedMaxTokens({ maxTokens: -1 }), true);
    assert.equal(hasUnlimitedMaxTokens({}), true);
    assert.equal(hasUnlimitedMaxTokens({ maxTokens: 32000 }), false);
    assert.equal(hasUnlimitedMaxTokens({ maxTokens: "32000" }), false);
  });

  it("maps a -1 config sentinel to 0 on the registered model", () => {
    const provider = providerDef("zzznegs");
    provider.models = [{ id: "m", input: ["text"], maxTokens: "-1", contextWindow: -1 }];
    const { models } = buildModels({ provider, apiKey: "k" });
    const model = models.getModel("zzznegs", "m");
    assert.equal(model.maxTokens, 0);
    assert.equal(model.contextWindow, 0);
    assert.equal(hasUnlimitedMaxTokens(model), true);
  });

  it("strips max_tokens/max_completion_tokens from the request payload", async () => {
    const hook = stripMaxTokensOnPayload();
    const params = { model: "m", max_tokens: 1, max_completion_tokens: 1, temperature: 0.2 };
    const out = await hook(params, { id: "m" });
    assert.equal(out.max_tokens, undefined);
    assert.equal(out.max_completion_tokens, undefined);
    assert.equal(out.temperature, 0.2);
  });

  it("chains an existing onPayload hook and honors its returned object", async () => {
    const seen = [];
    const existing = (params) => {
      seen.push(params);
      return { ...params, max_tokens: 1, marker: true };
    };
    const hook = stripMaxTokensOnPayload(existing);
    const out = await hook({ max_tokens: 5 }, { id: "m" });
    assert.equal(seen.length, 1);
    assert.equal(out.marker, true);
    assert.equal(out.max_tokens, undefined);
  });

  it("falls back to the original params when the existing hook returns undefined", async () => {
    const hook = stripMaxTokensOnPayload(() => undefined);
    const params = { max_completion_tokens: 3 };
    const out = await hook(params, { id: "m" });
    assert.equal(out, params);
    assert.equal(out.max_completion_tokens, undefined);
  });
});
