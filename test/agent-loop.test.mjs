import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentSession } from "../agent/lib/agent-runner.mjs";
import { bindControlTools, advisorControlToolDefs, researcherControlToolDefs } from "../agent/lib/control-tools.mjs";
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
  const control = bindControlTools(
    role === "researcher" ? researcherControlToolDefs() : advisorControlToolDefs(),
    controller,
  );
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

function planResponse(goalId) {
  return fauxAssistantMessage(
    [
      fauxText(`Here is the plan for ${goalId}.`),
      fauxToolCall("submit_plan", {
        goalId,
        title: `Goal ${goalId}`,
        plan: ["do a", "do b"],
        acceptanceCriteria: ["a is done", "b is done"],
      }),
    ],
    { stopReason: "toolUse" },
  );
}

function resultResponse(goalId) {
  return fauxAssistantMessage(
    [
      fauxText(`Result for ${goalId}.`),
      fauxToolCall("submit_result", {
        goalId,
        summary: "Implemented and tested.",
        artifacts: ["src/a.txt"],
        verification: ["ran tests"],
        status: "complete",
      }),
    ],
    { stopReason: "toolUse" },
  );
}

function taskRequestResponse() {
  return fauxAssistantMessage(
    [
      fauxText("All goals complete."),
      fauxToolCall("request_task_completion", {
        summary: "Done.",
        deliverables: ["src/a.txt"],
      }),
    ],
    { stopReason: "toolUse" },
  );
}

function advisorResponse(tool, payload) {
  return fauxAssistantMessage(
    [fauxText(`Advisor: ${tool}.`), fauxToolCall(tool, payload)],
    { stopReason: "toolUse" },
  );
}

function skillsProposalResponse() {
  return fauxAssistantMessage(
    [
      fauxText("Proposing skills."),
      fauxToolCall("propose_skills", {
        summary: "A testing skill is relevant.",
        skills: [{ name: "tdd", source: "owner/repo", why: "test-driven development" }],
      }),
    ],
    { stopReason: "toolUse" },
  );
}

function skillsReadyResponse() {
  return fauxAssistantMessage(
    [
      fauxText("Installed the approved skills."),
      fauxToolCall("confirm_skills_installed", { installed: [] }),
    ],
    { stopReason: "toolUse" },
  );
}

describe("end-to-end loop (faux provider)", () => {
  it("runs the full turn-taking protocol through the broker", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-loop-e2e-"));
    const transcripts = path.join(tmp, "transcripts");
    const broker = createBroker({
      token: "t",
      task: "Design a thing.",
      transcriptDir: transcripts,
      sessionId: "s1",
      maxHandoffs: 20,
    });

    const rFaux = makeFaux();
    const aFaux = makeFaux();

    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      responses: [
        skillsProposalResponse(),
        skillsReadyResponse(),
        planResponse("G1"),
        resultResponse("G1"),
        taskRequestResponse(),
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
        advisorResponse("approve_plan", { goalId: "G1", feedback: "go" }),
        advisorResponse("accept_result", { goalId: "G1", feedback: "verified" }),
        advisorResponse("accept_task_completion", { summary: "complete", feedback: "ok" }),
      ],
    });
    await researcher.start();
    await advisor.start();
    broker.start();

    let rCursor = 0;
    let aCursor = 0;
    const step = async (role, session, cursor) => {
      const batch = await broker.poll(role, cursor, 200);
      assert.ok(batch.messages.length > 0, `${role} expected a message`);
      const c = batch.cursor;
      for (const envelope of batch.messages) {
        const prompt =
          envelope.role === "control"
            ? envelope.text
            : renderInbound(envelope);
        const { error } = await session.runPrompt(prompt);
        assert.equal(error, null, `${role} phase error: ${error}`);
        const handoff = session.takeHandoff();
        assert.ok(handoff, `${role} produced no handoff`);
        const res = broker.receiveAgentEnvelope(role, handoff);
        assert.equal(res.ok, true, `${role} handoff rejected: ${res.error}`);
      }
      return c;
    };

    // researcher start -> skills proposal
    rCursor = await step("researcher", researcher, rCursor);
    assert.equal(broker.snapshot().state, "ADVISOR_REVIEW_SKILLS");

    // advisor approves skills -> researcher installs
    aCursor = await step("advisor", advisor, aCursor);
    assert.equal(broker.snapshot().state, "RESEARCHER_INSTALL_SKILLS");

    // researcher confirms installed -> planning (a prompt is queued for the researcher)
    rCursor = await step("researcher", researcher, rCursor);
    assert.equal(broker.snapshot().state, "RESEARCHER_DECOMPOSE");

    // researcher plan -> advisor reviews
    rCursor = await step("researcher", researcher, rCursor);
    assert.equal(broker.snapshot().state, "ADVISOR_REVIEW_PLAN");

    // advisor approves -> researcher executes
    aCursor = await step("advisor", advisor, aCursor);
    assert.equal(broker.snapshot().state, "RESEARCHER_EXECUTE");

    // researcher result -> advisor reviews
    rCursor = await step("researcher", researcher, rCursor);
    assert.equal(broker.snapshot().state, "ADVISOR_REVIEW_RESULT");

    // advisor accepts -> goal met
    aCursor = await step("advisor", advisor, aCursor);
    assert.equal(broker.snapshot().state, "RESEARCHER_DECOMPOSE");

    // researcher requests task completion -> advisor reviews task
    rCursor = await step("researcher", researcher, rCursor);
    assert.equal(broker.snapshot().state, "ADVISOR_REVIEW_TASK");

    // advisor accepts task -> awaiting human
    aCursor = await step("advisor", advisor, aCursor);
    assert.equal(broker.snapshot().state, "AWAITING_HUMAN");

    // human approves -> done
    const decision = broker.humanDecision({ action: "approve", text: "great" });
    assert.equal(decision.terminal, "done");
    assert.equal(broker.snapshot().state, "DONE");

    // Transcripts exist for both agents and session.
    assert.ok(fs.existsSync(path.join(transcripts, "researcher.jsonl")));
    assert.ok(fs.existsSync(path.join(transcripts, "advisor.jsonl")));
    assert.ok(fs.existsSync(path.join(transcripts, "session.jsonl")));
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
        planResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should still produce a handoff after recovering");
    assert.equal(handoff.kind, "proposal");
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
        planResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should recover and produce a handoff");
    assert.equal(handoff.kind, "proposal");
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
        planResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null);
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should recover and produce a handoff");
    assert.equal(handoff.kind, "proposal");
    assert.ok(
      researcher.stats().providerErrorRetries >= 1,
      "should record a provider-error retry",
    );
  });

  it("rejects an out-of-order handoff and asks the sender to retry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-loop-e2e-bad-"));
    const broker = createBroker({
      token: "t",
      task: "x",
      transcriptDir: path.join(tmp, "transcripts"),
      sessionId: "s2",
      skipSkills: true,
    });
    broker.register("researcher");
    const rFaux = makeFaux();
    const researcher = makeSession({
      role: "researcher",
      tmp,
      faux: rFaux.faux,
      models: rFaux.models,
      model: rFaux.model,
      // First a valid proposal, then an illegal result while the advisor is reviewing.
      responses: [planResponse("G1"), resultResponse("G1")],
    });
    await researcher.start();
    const first = await broker.poll("researcher", 0, 200);
    for (const env of first.messages) {
      await researcher.runPrompt(env.role === "control" ? env.text : renderInbound(env));
      const h = researcher.takeHandoff();
      const res = broker.receiveAgentEnvelope("researcher", h);
      assert.equal(res.ok, true);
    }
    // Now send an illegal result (advisor is reviewing the plan).
    const illegal = {
      role: "researcher",
      kind: "result",
      goalId: "G1",
      text: "sneaky",
      payload: {},
      ts: Date.now(),
    };
    const res = broker.receiveAgentEnvelope("researcher", illegal);
    assert.equal(res.ok, false);
    // A correction prompt should be queued for the researcher.
    const correction = await broker.poll("researcher", 0, 200);
    const kinds = correction.messages.map((m) => m.kind);
    assert.ok(kinds.includes("prompt"));
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
        planResponse("G1"),
      ],
    });
    await researcher.start();
    const { error } = await researcher.runPrompt("start");
    assert.equal(error, null, "should recover by compacting, not fail");
    const handoff = researcher.takeHandoff();
    assert.ok(handoff, "should still produce a handoff after compaction");
    assert.equal(handoff.kind, "proposal");
    const stats = researcher.stats();
    assert.equal(stats.proximityCompactions, 1, "should compact once");
    assert.ok(
      stats.warnings.some((w) => w.startsWith("compaction:")),
      "should record a compaction warning",
    );
  });
});
