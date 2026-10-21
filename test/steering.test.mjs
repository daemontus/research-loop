import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import { bindControlTools, CONTROL_TOOLS_BY_KIND } from "../agent/lib/control-tools.mjs";
import { makeCredentialStore } from "../agent/lib/model-providers.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";

function makeSession(responses, extraTools = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-steer-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = builtinModels({ credentials: makeCredentialStore({}) });
  models.setProvider(faux.provider);
  const controlState = { pendingHandoff: null };
  const controller = {
    setHandoff: (h) => {
      if (controlState.pendingHandoff) return false;
      controlState.pendingHandoff = h;
      return true;
    },
  };
  const session = new AgentSession({
    role: "researcher",
    model: models.getModel("faux", "m1"),
    models,
    systemPrompt: "You are the researcher.",
    tools: [...extraTools, ...bindControlTools(CONTROL_TOOLS_BY_KIND.leaf.researcher, controller)],
    sandbox: tmp,
    transcript: createTranscriptWriter(path.join(tmp, "researcher.jsonl"), "researcher"),
    controlState,
    maxTurnsPerPhase: 10,
    providerErrorBackoffMs: 0,
  });
  faux.setResponses(responses);
  return session;
}

const plan = (goalId) =>
  fauxAssistantMessage(
    [fauxText("plan"), fauxToolCall("submit_result", { summary: goalId, report: "r", notes: "n" })],
    { stopReason: "toolUse" },
  );

const userTexts = (session) =>
  session.agent.state.messages
    .filter((m) => m.role === "user")
    .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text).join("") : m.content));

describe("human-note steering", () => {
  it("injects a note into the running phase without starting another one", async () => {
    let session;
    const work = {
      name: "work",
      label: "Work",
      description: "does work",
      parameters: Type.Object({}),
      execute: async () => {
        // The human writes while the agent is busy in a tool call.
        session.steer("HUMAN NOTE");
        return { content: [{ type: "text", text: "worked" }], details: {} };
      },
    };
    session = makeSession(
      [fauxAssistantMessage([fauxToolCall("work", {})], { stopReason: "toolUse" }), plan("G1")],
      [work],
    );
    await session.start();
    await session.runPrompt("start");
    const handoff = session.takeHandoff();
    assert.equal(handoff?.kind, "submit_result", "the phase still ends with its own handoff");
    assert.deepEqual(userTexts(session), ["start", "HUMAN NOTE"]);
    assert.equal(session.pendingSteer.length, 0);
    assert.equal(session.isRunning(), false);
  });

  it("carries a note that arrives between phases into the next phase", async () => {
    const session = makeSession([plan("G1"), plan("G2")]);
    await session.start();
    await session.runPrompt("first");
    session.takeHandoff();
    session.steer("LATE NOTE");
    // Recreating the agent (as compaction does) must not lose the note.
    session.agent = session.makeAgent();
    session.wire(session.agent);
    session.agent.state.messages = [];
    await session.runPrompt("second");
    assert.equal(session.takeHandoff()?.payload.summary, "G2");
    assert.deepEqual(userTexts(session), ["second", "LATE NOTE"]);
    assert.equal(session.pendingSteer.length, 0);
  });
});
