import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import {
  clientSessionId,
  providerRequestHeaders,
  USER_AGENT,
} from "../agent/lib/client-identity.mjs";
import { buildModels } from "../agent/lib/model-providers.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";

/** Mock provider: records each request's headers and fails it fast. */
async function withMockServer(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock", type: "invalid_request_error" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

async function requestHeadersFor(modelId, { provider = "opencode-go", sessionId = "sid-1" } = {}) {
  return withMockServer(async (base, seen) => {
    const { models } = buildModels({ apiKey: "sk-test", providerId: provider });
    const catalog = models.getModel(provider, modelId);
    assert.ok(catalog, `${provider}:${modelId} should be in the built-in catalog`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-oc-"));
    // Same provider/model, but pointed at the mock server (keep the /v1 shape).
    const baseUrl = new URL(catalog.baseUrl).pathname.endsWith("/v1") ? `${base}/v1` : base;
    const session = new AgentSession({
      role: "researcher",
      model: { ...catalog, baseUrl },
      models,
      systemPrompt: "x",
      tools: [],
      sandbox: tmp,
      transcript: createTranscriptWriter(path.join(tmp, "t.jsonl"), "researcher"),
      maxProviderRetries: 0,
      maxProviderErrorRetries: 0,
      clientSessionId: sessionId,
    });
    await session.start();
    await session.runPrompt("hi");
    assert.ok(seen.length >= 1, "the provider should have been called");
    return seen[0].headers;
  });
}

describe("OpenCode client identification", () => {
  for (const modelId of ["deepseek-v4-flash", "minimax-m3", "gpt-5.6-luna"]) {
    it(`sends session + identity headers (opencode-go:${modelId})`, async () => {
      const h = await requestHeadersFor(modelId);
      assert.equal(h["x-opencode-session"], "sid-1");
      assert.equal(h["x-opencode-client"], "research-loop");
      assert.equal(h["user-agent"], USER_AGENT);
      assert.match(USER_AGENT, /^research-loop\/\d+\.\d+\.\d+$/);
    });
  }

  it("adds nothing for other providers", () => {
    assert.deepEqual(
      providerRequestHeaders({ provider: "psyche", baseUrl: "https://example.org/v1" }, "s"),
      {},
    );
    assert.equal(
      providerRequestHeaders({ provider: "custom", baseUrl: "https://opencode.ai/zen/v1" }, "s")[
        "x-opencode-session"
      ],
      "s",
      "custom providers pointed at opencode.ai are recognized too",
    );
  });

  it("derives a stable UUID per run and role", () => {
    const a = clientSessionId("2026-10-14T08-23-11-081", "researcher");
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a, clientSessionId("2026-10-14T08-23-11-081", "researcher"));
    assert.notEqual(a, clientSessionId("2026-10-14T08-23-11-081", "advisor"));
  });
});

describe("built-in catalog extension (pi_config.json `like`)", () => {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), "rl-ext-"));
  const configPath = path.join(S, "pi_config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        { id: "opencode-go", models: [{ id: "deepseek-v9-test", like: "deepseek-v4-flash" }] },
      ],
    }),
  );

  it("clones a catalog model under a new id and keeps the catalog", () => {
    const { models } = buildModels({ configPath, apiKey: "k", providerId: "opencode-go" });
    const base = models.getModel("opencode-go", "deepseek-v4-flash");
    const added = models.getModel("opencode-go", "deepseek-v9-test");
    assert.ok(base && added);
    assert.equal(added.provider, "opencode-go");
    assert.equal(added.baseUrl, base.baseUrl);
    assert.deepEqual(added.compat, base.compat);
  });

  it("orchestrator resolves it and hands the definition to the agent", async () => {
    const { resolveCredentials } = await import("../orchestrator/credentials.mjs");
    const prev = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "sk-test";
    try {
      const creds = await resolveCredentials("opencode-go:deepseek-v9-test::high", configPath);
      assert.equal(creds.apiKey, "sk-test");
      assert.equal(creds.extraModel?.id, "deepseek-v9-test");
      const plain = await resolveCredentials("opencode-go:deepseek-v4-flash", configPath);
      assert.equal(plain.extraModel, undefined, "catalog models need no definition");
      const unknown = await resolveCredentials("opencode-go:nope", configPath);
      assert.match(unknown.error, /not in pi-ai's 'opencode-go' catalog/);

      // Agent side: no pi_config.json, only the job's extraModels.
      const { models } = buildModels({
        apiKey: creds.apiKey,
        providerId: "opencode-go",
        extraModels: [creds.extraModel],
      });
      assert.ok(models.getModel("opencode-go", "deepseek-v9-test"));
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prev;
    }
  });

  it("rejects an extension without a known template", () => {
    fs.writeFileSync(
      path.join(S, "bad.json"),
      JSON.stringify({ providers: [{ id: "opencode-go", models: [{ id: "x", like: "nope" }] }] }),
    );
    assert.throws(() => buildModels({ configPath: path.join(S, "bad.json") }), /not in pi-ai's catalog/);
  });
});
