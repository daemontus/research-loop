import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import { bindControlTools, CONTROL_TOOLS_BY_KIND } from "../agent/lib/control-tools.mjs";
import { makeCredentialStore } from "../agent/lib/model-providers.mjs";
import { renderInbound } from "../agent/lib/protocol.mjs";
import { makeTools } from "../agent/lib/tools.mjs";
import { createTranscriptWriter } from "../agent/lib/transcript.mjs";
import { createBroker } from "../control-plane/broker.mjs";

function makeFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = builtinModels({ credentials: makeCredentialStore({}) });
  models.setProvider(faux.provider);
  return { faux, models, model: models.getModel("faux", "m1") };
}

function makeSession({ role, tmp, faux, models, model, responses }) {
  const sandbox = path.join(tmp, role);
  fs.mkdirSync(sandbox, { recursive: true });
  const controlState = { pendingHandoff: null };
  const controller = {
    setHandoff: (h) => {
      if (controlState.pendingHandoff) return false;
      controlState.pendingHandoff = h;
      return true;
    },
  };
  const generic = makeTools(sandbox, { configDir: null, prefetchPath: "/prefetch", supportsImage: false });
  // One conversation serves every session here, so offer every tool of the role.
  const names = [...new Set(Object.values(CONTROL_TOOLS_BY_KIND).flatMap((k) => k[role]))];
  const control = bindControlTools(names, controller);
  const session = new AgentSession({
    role,
    model,
    models,
    systemPrompt: `You are the ${role}.`,
    tools: [...generic, ...control],
    sandbox,
    transcript: createTranscriptWriter(path.join(tmp, "transcripts", `${role}.jsonl`), role),
    controlState,
    maxTurnsPerPhase: 10,
    abortTimeoutMs: 10000,
    providerErrorBackoffMs: 0,
  });
  faux.setResponses(responses);
  return session;
}

/** A phase-ending handoff (a leaf researcher's result). */
function workResponse(goalId) {
  return fauxAssistantMessage(
    [
      fauxText(`Result for ${goalId}.`),
      fauxToolCall("submit_result", {
        summary: "Implemented and tested.",
        report: `Implemented ${goalId}.`,
        notes: "None.",
        artifacts: ["src/a.txt"],
        verification: ["ran tests"],
      }),
    ],
    { stopReason: "toolUse" },
  );
}

function researcherResponse(tool, payload) {
  return fauxAssistantMessage([fauxText(`Researcher: ${tool}.`), fauxToolCall(tool, payload)], { stopReason: "toolUse" });
}

function advisorResponse(tool, payload) {
  return fauxAssistantMessage(
    [fauxText(`Advisor: ${tool}.`), fauxToolCall(tool, payload)],
    { stopReason: "toolUse" },
  );
}


describe("end-to-end loop (faux provider)", () => {
  it("runs the full protocol through the broker: skills, plan, a delegated goal, human sign-off", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-loop-e2e-"));
    const broker = createBroker({ task: "Design a thing.", runDir: tmp, sessionId: "s1", maxHandoffs: 40 });
    const goal = { id: "G1", title: "Design", description: "Design the thing.", acceptance: ["design.md explains it"] };

    const rFaux = makeFaux();
    const aFaux = makeFaux();
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      responses: [
        researcherResponse("propose_skills", { summary: "none", noneNeeded: true, skills: [] }),
        researcherResponse("accept_plan", { feedback: "clear" }),
        researcherResponse("propose_subagent", { goalId: "G1", mode: "full", instructions: "Write design.md.", justification: "Small." }),
        workResponse("G1"),
        researcherResponse("finish_session", { summary: "Done.", notes: "none" }),
      ],
    });
    const advisor = makeSession({
      role: "advisor",
      tmp,
      faux: aFaux.faux,
      models: aFaux.models,
      model: aFaux.model,
      responses: [
        advisorResponse("approve_skills", { feedback: "ok" }),
        advisorResponse("propose_plan", { goals: [goal], rationale: "one goal" }),
        advisorResponse("approve_subagent", { feedback: "go" }),
        advisorResponse("accept_result", { feedback: "verified", verification: ["read design.md"] }),
      ],
    });
    await researcher.start();
    await advisor.start();
    broker.start();

    const cursors = { researcher: 0, advisor: 0 };
    const sessions = { researcher, advisor };
    // Run every queued phase of `role`, returning the session it acted in.
    const step = async (role) => {
      const batch = await broker.poll(role, cursors[role], 200);
      cursors[role] = batch.cursor;
      let acted = null;
      for (const envelope of batch.messages) {
        if (envelope.kind === "agent_done") continue;
        const prompt = envelope.role === "control" ? envelope.text : renderInbound(envelope);
        const { error } = await sessions[role].runPrompt(prompt);
        assert.equal(error, null, `${role} phase error: ${error}`);
        const handoff = sessions[role].takeHandoff();
        assert.ok(handoff, `${role} produced no handoff`);
        const res = broker.receiveAgentEnvelope(role, { ...handoff, agentId: envelope.agentId });
        assert.equal(res.ok, true, `${role} handoff rejected: ${res.error}`);
        acted = envelope.agentId;
      }
      assert.ok(acted, `${role} expected a message`);
      return acted;
    };
    const state = () => broker.snapshot();

    assert.equal(await step("researcher"), "skills");
    assert.equal(state().activeState, "SKILLS_REVIEW");
    await step("advisor"); // approve (nothing to install) -> main starts with the advisor planning
    await step("advisor"); // propose_plan
    assert.equal(state().activeState, "PLAN_REVIEW");
    await step("researcher"); // accept_plan, then the harness asks it to prepare G1
    await step("researcher"); // propose_subagent
    assert.equal(state().activeState, "SUBAGENT_REVIEW");
    await step("advisor"); // approve_subagent -> leaf S1
    assert.equal(state().activeAgent, "S1");
    assert.equal(await step("researcher"), "S1"); // submit_result
    await step("advisor"); // accept_result -> back to main, reflecting
    assert.equal(state().activeAgent, "root");
    assert.equal(state().activeState, "REFLECT");
    await step("researcher"); // finish_session
    assert.equal(state().state, "AWAITING_HUMAN");
    assert.equal(broker.humanDecision({ action: "approve", text: "great" }).ok, true);
    assert.equal(state().state, "DONE");

    assert.equal(broker.goalTree().goals[0].status, "done");
    assert.ok(fs.existsSync(path.join(tmp, "control", "session.jsonl")));
    assert.match(fs.readFileSync(path.join(tmp, "goals.md"), "utf8"), /\[x\] G1 — Design/);
    assert.ok(fs.existsSync(path.join(tmp, "agents", "S1", "report.md")));
    assert.ok(fs.existsSync(path.join(tmp, "plans", "root", "v1.json")));
  });

  it("recovers from a context-overflow provider error by compacting and retrying", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-overflow-"));
    const rFaux = makeFaux();
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      responses: [
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage:
            "Requested token count exceeds the model's maximum context length. " +
            "Please reduce the number of tokens.",
        }),
        workResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should still produce a handoff after recovering");
    assert.equal(handoff.kind, "submit_result");
    assert.ok(
      researcher.stats().contextOverflowRetries >= 1,
      "should record a context-overflow retry",
    );
  });

  it("recovers from an abort-encoded-as-error by retrying", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-abort-"));
    const rFaux = makeFaux();
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      responses: [
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "This operation was aborted",
        }),
        workResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should recover and produce a handoff");
    assert.equal(handoff.kind, "submit_result");
    assert.ok(researcher.stats().abortRetries >= 1, "should record an abort retry");
  });

  it("recovers from a transient provider drop by retrying", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-transient-"));
    const rFaux = makeFaux();
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      responses: [
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
        workResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should recover and produce a handoff");
    assert.equal(handoff.kind, "submit_result");
    assert.ok(
      researcher.stats().providerErrorRetries >= 1,
      "should record a provider-error retry",
    );
  });

  it("ignores an out-of-turn handoff and corrects an illegal one", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-loop-e2e-bad-"));
    const broker = createBroker({ task: "x", runDir: tmp, sessionId: "s2", skipSkills: true });
    broker.start();
    // The advisor plans first; the researcher acting now is out of turn and just waits.
    const early = broker.receiveAgentEnvelope("researcher", { role: "researcher", kind: "accept_plan", text: "", payload: {}, ts: Date.now() });
    assert.equal(early.ok, false);
    assert.equal(early.wait, true);
    assert.equal((await broker.poll("researcher", 0, 50)).messages.length, 0, "no correction for an out-of-turn handoff");
    // An action that is not allowed now gets a correction prompt.
    const illegal = broker.receiveAgentEnvelope("advisor", { role: "advisor", kind: "approve_subagent", text: "", payload: {}, ts: Date.now() });
    assert.equal(illegal.ok, false);
    const msgs = (await broker.poll("advisor", 0, 50)).messages;
    const correction = msgs.find((m) => m.kind === "prompt");
    assert.ok(correction);
    assert.match(correction.text, /call one of: `propose_plan`/);
  });

  it("compacts mid-phase when the prompt approaches the context window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-proximity-"));
    const rFaux = makeFaux();
    // Small window: the giant bash output below pushes the reported prompt size
    // (input + cacheRead, per pi-ai's usage accounting) well past the reserve.
    const model = { ...rFaux.model, contextWindow: 10000, maxTokens: 100 };
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model,
      responses: [
        fauxAssistantMessage(
          [fauxText("Dumping data."), fauxToolCall("bash", { command: "python3 -c \"print('x'*60000)\"" })],
          { stopReason: "toolUse" },
        ),
        // A second ordinary tool turn so the proximity check runs *after* the big
        // tool result has entered the prompt.
        fauxAssistantMessage(
          [fauxText("Inspecting."), fauxToolCall("read_file", { path: "notes.md" })],
          { stopReason: "toolUse" },
        ),
        workResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null, "should recover by compacting, not fail");
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should still produce a handoff after compaction");
    assert.equal(handoff.kind, "submit_result");
    const stats = researcher.stats();
    assert.equal(stats.proximityCompactions, 1, "should compact once");
    assert.ok(
      stats.warnings.some((w) => w.startsWith("compaction:")),
      "should record a compaction warning",
    );
  });
});
