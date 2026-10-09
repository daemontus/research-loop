import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { buildModels, resolveModel } from "../agent/lib/model-providers.mjs";
import { discoverModelLimits } from "../orchestrator/credentials.mjs";

function providerDef(id, model = { id: "m" }) {
  return { id, name: id, baseUrl: "http://127.0.0.1:1", apiKeyEnv: `${id}_KEY`, models: [model] };
}

describe("model limit defaults", () => {
  it("sends no cap and no fabricated window by default", () => {
    const { models } = buildModels({ provider: providerDef("zzzdef"), apiKey: "k" });
    const model = resolveModel(models, "zzzdef:m").model;
    assert.equal(model.maxTokens, 0, "no output cap unless configured/detected");
    assert.equal(model.contextWindow, 0, "no fabricated context window");
  });

  it("honors explicit per-model contextWindow and maxTokens", () => {
    const provider = providerDef("zzzlim", { id: "m", contextWindow: 262144, maxTokens: 32000 });
    const { models } = buildModels({ provider, apiKey: "k" });
    const model = resolveModel(models, "zzzlim:m").model;
    assert.equal(model.contextWindow, 262144);
    assert.equal(model.maxTokens, 32000);
  });
});

describe("discoverModelLimits", () => {
  it("reads LiteLLM-style /models limits", async () => {
    const server = http.createServer((req, res) => {
      assert.match(req.url, /\/models$/);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "qwen3.8-27b", max_input_tokens: 262144, max_output_tokens: 32000 }],
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const found = await discoverModelLimits(
        { id: "einfra", baseUrl: `http://127.0.0.1:${port}` },
        "qwen3.8-27b",
        "k",
      );
      assert.equal(found.contextWindow, 262144);
      assert.equal(found.maxTokens, 32000);
    } finally {
      server.close();
    }
  });

  it("returns {} when the endpoint is unreachable", async () => {
    const found = await discoverModelLimits(
      { id: "x", baseUrl: "http://127.0.0.1:1" },
      "m",
      "k",
      { timeoutMs: 300 },
    );
    assert.deepEqual(found, {});
  });
});
