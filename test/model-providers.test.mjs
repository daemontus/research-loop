import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProviderConfigured,
  buildModels,
  resolveModel,
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
