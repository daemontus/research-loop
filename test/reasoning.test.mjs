import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveThinkingLevel } from "../agent/lib/model-providers.mjs";
import { reasoningParams } from "../scripts/reasoning-params.mjs";

describe("reasoning effort selection", () => {
  it("prefers the model spec's ::effort over --thinking", () => {
    assert.deepEqual(resolveThinkingLevel("psyche:qwen::high", "medium"), { level: "high", source: "model spec" });
    assert.deepEqual(resolveThinkingLevel("psyche:qwen", "low"), { level: "low", source: "--thinking" });
    assert.deepEqual(resolveThinkingLevel("psyche:qwen", null), { level: "off", source: "default" });
    assert.deepEqual(resolveThinkingLevel("opencode-go:deepseek-v4.1-flash::max"), { level: "max", source: "model spec" });
  });

  it("rejects unknown levels instead of letting pi-ai fall back silently", () => {
    assert.match(resolveThinkingLevel("psyche:qwen::extreme", "medium").error, /unknown reasoning effort 'extreme' \(model spec/);
    assert.match(resolveThinkingLevel("psyche:qwen", "turbo").error, /'turbo' \(--thinking/);
  });
});

function config(models, provider = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-reasoning-")), "pi_config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ providers: [{ id: "local", baseUrl: "http://llm.test/v1", apiKeyEnv: "LOCAL_TEST_KEY", models, ...provider }] }),
  );
  return file;
}

const sent = async (file, id) => (await reasoningParams(file, [`local:${id}`]))[0].params;

describe("reasoning parameters sent to the provider", () => {
  it("custom reasoning models get reasoning_effort verbatim up to high; xhigh/max are capped; off sends nothing", async () => {
    const p = await sent(config([{ id: "m", reasoning: true }]), "m");
    assert.deepEqual(p.off, {});
    for (const level of ["minimal", "low", "medium", "high"]) assert.deepEqual(p[level], { reasoning_effort: level });
    assert.deepEqual(p.xhigh, { reasoning_effort: "high" });
    assert.deepEqual(p.max, { reasoning_effort: "high" });
  });

  it("a model with reasoning: false never gets a reasoning parameter", async () => {
    const p = await sent(config([{ id: "m" }]), "m");
    for (const level of Object.keys(p)) assert.deepEqual(p[level], {}, level);
  });

  it("thinkingLevelMap passes xhigh/max through, sends an explicit off, and clamps null levels upward", async () => {
    const p = await sent(
      config([{ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", off: "none", medium: null } }]),
      "m",
    );
    assert.deepEqual(p.xhigh, { reasoning_effort: "xhigh" });
    assert.deepEqual(p.max, { reasoning_effort: "max" });
    assert.deepEqual(p.off, { reasoning_effort: "none" });
    assert.deepEqual(p.medium, { reasoning_effort: "high" }, "unsupported medium becomes the next higher level");
  });

  it("compat.thinkingFormat switches the parameter style", async () => {
    const p = await sent(config([{ id: "m", reasoning: true, compat: { thinkingFormat: "qwen" } }]), "m");
    assert.deepEqual(p.high, { enable_thinking: true, reasoning_effort: "high" });
    assert.deepEqual(p.off, { enable_thinking: false });
  });

  it("OpenRouter base URLs use the reasoning object, with an explicit none for off", async () => {
    const p = await sent(config([{ id: "m", reasoning: true }], { baseUrl: "https://openrouter.ai/api/v1" }), "m");
    assert.deepEqual(p.medium, { reasoning: { effort: "medium" } });
    assert.deepEqual(p.off, { reasoning: { effort: "none" } });
  });

  it("chat-template fills $var placeholders and honours omitWhenOff (README example)", async () => {
    const p = await sent(
      config([
        {
          id: "m",
          reasoning: true,
          compat: {
            thinkingFormat: "chat-template",
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
              reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
            },
          },
        },
      ]),
      "m",
    );
    assert.deepEqual(p.high, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" } });
    assert.deepEqual(p.off, { chat_template_kwargs: { enable_thinking: false } });
  });

  it("a thinking-token budget is sent only when the model's maxTokens is known", async () => {
    const compat = { thinkingTokenBudgetField: "thinking_token_budget" };
    const file = config([
      { id: "known", reasoning: true, maxTokens: 32000, compat },
      { id: "unknown", reasoning: true, compat },
    ]);
    const known = await sent(file, "known");
    assert.deepEqual(known.medium, { reasoning_effort: "medium", thinking_token_budget: 8192 });
    assert.deepEqual(known.max, { reasoning_effort: "high", thinking_token_budget: 16384 });
    assert.deepEqual((await sent(file, "unknown")).medium, { reasoning_effort: "medium" });
  });

  it("supportsReasoningEffort: false silences the openai format entirely", async () => {
    const p = await sent(config([{ id: "m", reasoning: true, compat: { supportsReasoningEffort: false } }]), "m");
    for (const level of Object.keys(p)) assert.deepEqual(p[level], {}, level);
  });

  it("a custom model configured like OpenCode Go's DeepSeek gets the same parameters (README example)", async () => {
    const p = await sent(
      config([
        {
          id: "m",
          reasoning: true,
          compat: { thinkingFormat: "deepseek" },
          thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
        },
      ]),
      "m",
    );
    assert.deepEqual(p.off, { thinking: { type: "disabled" } });
    assert.deepEqual(p.medium, { reasoning_effort: "high", thinking: { type: "enabled" } });
    assert.deepEqual(p.xhigh, { reasoning_effort: "max", thinking: { type: "enabled" } });
  });

  it("every custom model in the shipped pi_config.json is reasoning-capable", () => {
    const cfg = JSON.parse(fs.readFileSync(new URL("../pi_config.json", import.meta.url), "utf8"));
    for (const p of cfg.providers.filter((p) => p.baseUrl)) {
      for (const m of p.models) assert.equal(m.reasoning, true, `${p.id}:${m.id}`);
    }
  });
});
