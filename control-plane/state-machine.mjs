/**
 * Turn-taking state machine for the research loop.
 *
 * Pure and synchronous so it can be unit-tested without containers or network.
 *
 * Responsibilities:
 *   - gate legal handoff transitions
 *   - route each accepted handoff to the peer (as a delivery)
 *   - track the current goal and counters
 *   - signal human review and terminal states
 *
 * States:
 *   INIT -> RESEARCHER_DECOMPOSE -> ADVISOR_REVIEW_PLAN -> RESEARCHER_EXECUTE
 *        -> ADVISOR_REVIEW_RESULT -> RESEARCHER_DECOMPOSE (loop)
 *        -> ADVISOR_REVIEW_TASK -> AWAITING_HUMAN -> DONE | RESEARCHER_DECOMPOSE
 *
 * Subagents: from RESEARCHER_DECOMPOSE/EXECUTE the researcher may propose a
 * subagent (-> ADVISOR_REVIEW_SUBAGENT). On approval this session pauses in
 * SUBAGENT_RUNNING until the child finishes (applySubagentDone), then returns
 * to the state the proposal was made from. A subagent's own session state has
 * `subagent: true`: it skips skills and human sign-off, so an accepted task
 * completion ends it directly in DONE (terminal "subagent_done").
 */

export const STATES = {
  INIT: "INIT",
  RESEARCHER_SKILLS: "RESEARCHER_SKILLS",
  ADVISOR_REVIEW_SKILLS: "ADVISOR_REVIEW_SKILLS",
  RESEARCHER_INSTALL_SKILLS: "RESEARCHER_INSTALL_SKILLS",
  RESEARCHER_DECOMPOSE: "RESEARCHER_DECOMPOSE",
  ADVISOR_REVIEW_PLAN: "ADVISOR_REVIEW_PLAN",
  RESEARCHER_EXECUTE: "RESEARCHER_EXECUTE",
  ADVISOR_REVIEW_RESULT: "ADVISOR_REVIEW_RESULT",
  ADVISOR_REVIEW_TASK: "ADVISOR_REVIEW_TASK",
  ADVISOR_REVIEW_SUBAGENT: "ADVISOR_REVIEW_SUBAGENT",
  SUBAGENT_RUNNING: "SUBAGENT_RUNNING",
  AWAITING_HUMAN: "AWAITING_HUMAN",
  DONE: "DONE",
  ABORTED: "ABORTED",
};

/**
 * @param {{ subagent?: boolean }} [opts] `subagent` marks a child session
 *   (no skills phase, no human sign-off).
 */
export function createSessionState({ subagent = false } = {}) {
  return {
    state: STATES.INIT,
    subagent,
    // State to return to once a proposed subagent is rejected or finishes.
    subagentReturnState: null,
    currentGoalId: null,
    handoffs: 0,
    humanDecisions: [],
    startedAt: Date.now(),
    finishedAt: null,
    terminalReason: null,
  };
}

function delivery(to, envelope) {
  return { to, envelope };
}

/**
 * Mark the session as started. By default the researcher must first discover
 * and propose skills; pass `skipSkills` to go straight to planning.
 * @param {object} state
 * @param {{ skipSkills?: boolean }} [opts]
 */
export function applyStart(state, { skipSkills = false } = {}) {
  return {
    state: {
      ...state,
      state: skipSkills || state.subagent ? STATES.RESEARCHER_DECOMPOSE : STATES.RESEARCHER_SKILLS,
    },
    deliveries: [],
  };
}

/**
 * Apply an agent (researcher/advisor) handoff envelope.
 *
 * @returns {{ state: object, deliveries: Array<{to:string,envelope:object}>, error?: string, notice?: string, terminal?: "done"|"aborted" }}
 */
export function applyEnvelope(state, envelope) {
  const s = { ...state };
  const kind = envelope.kind;
  const fail = (error) => ({ state, deliveries: [], error });

  const next = (newState, extra = {}) => {
    s.state = newState;
    s.handoffs += 1;
    return { state: s, deliveries: [], ...extra };
  };

  // The researcher hands a self-contained subtask to a subagent; the advisor
  // must approve it first. Allowed from the planning and execution phases.
  const proposeSubagent = () => {
    s.subagentReturnState = state.state;
    return next(STATES.ADVISOR_REVIEW_SUBAGENT, {
      deliveries: [delivery("advisor", envelope)],
    });
  };

  // Accepted task completion: the human signs off a top-level session; a
  // subagent session simply ends (its report goes back to the parent). A
  // subagent may only finish through request_task_completion, which is where
  // the harness checks its report and protected files.
  const acceptTask = () => {
    if (!state.subagent) {
      return next(STATES.AWAITING_HUMAN, { notice: "advisor accepted task; awaiting human" });
    }
    if (state.state !== STATES.ADVISOR_REVIEW_TASK) {
      return fail(
        "a subagent can only be completed after the researcher calls request_task_completion",
      );
    }
    s.finishedAt = Date.now();
    s.terminalReason = "subagent completed";
    return next(STATES.DONE, { terminal: "subagent_done", notice: "subagent completed" });
  };

  switch (state.state) {
    case STATES.INIT:
      return fail("session not started");

    case STATES.RESEARCHER_SKILLS: {
      if (envelope.role !== "researcher") return fail(`expected researcher, got ${envelope.role}`);
      if (kind === "skills_proposal") {
        return next(STATES.ADVISOR_REVIEW_SKILLS, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      if (kind === "task_request") {
        return next(STATES.ADVISOR_REVIEW_TASK, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      return fail(`researcher cannot send '${kind}' during skills discovery; expected skills_proposal`);
    }

    case STATES.ADVISOR_REVIEW_SKILLS: {
      if (envelope.role !== "advisor") return fail(`expected advisor, got ${envelope.role}`);
      if (kind === "skills_approved") {
        return next(STATES.RESEARCHER_INSTALL_SKILLS, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      if (kind === "skills_changes") {
        return next(STATES.RESEARCHER_SKILLS, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      return fail(`advisor cannot send '${kind}' while reviewing skills; expected skills_approved or skills_changes`);
    }

    case STATES.RESEARCHER_INSTALL_SKILLS: {
      if (envelope.role !== "researcher") return fail(`expected researcher, got ${envelope.role}`);
      if (kind === "skills_ready") {
        return next(STATES.RESEARCHER_DECOMPOSE, {
          deliveries: [
            delivery("researcher", {
              role: "control",
              kind: "prompt",
              text: [
                "Skills step complete.",
                "",
                "Now decompose the task into a small set of high-level goals and write GOALS.md.",
                "Then propose the first goal with submit_plan. In the plan, list the installed",
                "skills you will use and reference them in the steps. Do not execute before the",
                "advisor approves.",
              ].join("\n"),
              payload: {},
              ts: Date.now(),
            }),
          ],
          notice: "skills installed",
        });
      }
      return fail(`researcher cannot send '${kind}' while installing skills; expected skills_ready`);
    }

    case STATES.RESEARCHER_DECOMPOSE: {
      if (envelope.role !== "researcher") return fail(`expected researcher, got ${envelope.role}`);
      if (kind === "proposal") {
        s.currentGoalId = envelope.goalId || null;
        return next(STATES.ADVISOR_REVIEW_PLAN, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      if (kind === "task_request") {
        return next(STATES.ADVISOR_REVIEW_TASK, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      if (kind === "subagent_proposal") return proposeSubagent();
      return fail(`researcher cannot send '${kind}' while decomposing; expected proposal`);
    }

    case STATES.ADVISOR_REVIEW_PLAN: {
      if (envelope.role !== "advisor") return fail(`expected advisor, got ${envelope.role}`);
      if (kind === "plan_approved") {
        return next(STATES.RESEARCHER_EXECUTE, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      if (kind === "plan_changes") {
        return next(STATES.RESEARCHER_DECOMPOSE, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      if (kind === "task_accepted") return acceptTask();
      return fail(`advisor cannot send '${kind}' while reviewing a plan`);
    }

    case STATES.RESEARCHER_EXECUTE: {
      if (envelope.role !== "researcher") return fail(`expected researcher, got ${envelope.role}`);
      if (kind === "result") {
        return next(STATES.ADVISOR_REVIEW_RESULT, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      if (kind === "proposal") {
        s.currentGoalId = envelope.goalId || s.currentGoalId;
        return next(STATES.ADVISOR_REVIEW_PLAN, {
          deliveries: [delivery("advisor", envelope)],
          notice: "plan revised",
        });
      }
      if (kind === "task_request") {
        return next(STATES.ADVISOR_REVIEW_TASK, {
          deliveries: [delivery("advisor", envelope)],
        });
      }
      if (kind === "subagent_proposal") return proposeSubagent();
      return fail(`researcher cannot send '${kind}' while executing`);
    }

    case STATES.ADVISOR_REVIEW_RESULT: {
      if (envelope.role !== "advisor") return fail(`expected advisor, got ${envelope.role}`);
      if (kind === "result_accepted") {
        return next(STATES.RESEARCHER_DECOMPOSE, {
          deliveries: [delivery("researcher", envelope)],
          notice: "goal met",
        });
      }
      if (kind === "result_changes") {
        return next(STATES.RESEARCHER_EXECUTE, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      if (kind === "task_accepted") return acceptTask();
      return fail(`advisor cannot send '${kind}' while reviewing a result`);
    }

    case STATES.ADVISOR_REVIEW_TASK: {
      if (envelope.role !== "advisor") return fail(`expected advisor, got ${envelope.role}`);
      if (kind === "task_accepted") return acceptTask();
      if (kind === "task_changes") {
        return next(STATES.RESEARCHER_DECOMPOSE, {
          deliveries: [delivery("researcher", envelope)],
        });
      }
      return fail(`advisor cannot send '${kind}' while reviewing task completion`);
    }

    case STATES.ADVISOR_REVIEW_SUBAGENT: {
      if (envelope.role !== "advisor") return fail(`expected advisor, got ${envelope.role}`);
      if (kind === "subagent_approved") {
        // No delivery: the control plane starts the child session and this
        // one stays paused until applySubagentDone.
        return next(STATES.SUBAGENT_RUNNING, { spawn: true, notice: "subagent approved" });
      }
      if (kind === "subagent_changes") {
        const back = state.subagentReturnState || STATES.RESEARCHER_DECOMPOSE;
        s.subagentReturnState = null;
        return next(back, { deliveries: [delivery("researcher", envelope)] });
      }
      return fail(`advisor cannot send '${kind}' while reviewing a subagent proposal; expected approve_subagent or reject_subagent`);
    }

    case STATES.SUBAGENT_RUNNING:
      return fail("a subagent is running; this session is paused until it reports back");

    case STATES.AWAITING_HUMAN:
      return fail("session is awaiting a human decision; agent messages are not accepted here");

    case STATES.DONE:
    case STATES.ABORTED:
      return fail(`session is already ${state.state}`);

    default:
      return fail(`unknown state: ${state.state}`);
  }
}

/**
 * Apply a human decision while awaiting final approval.
 * @param {object} state
 * @param {{ action: "approve"|"reject"|"extend", text?: string, target?: string }} decision
 */
export function applyHumanDecision(state, decision) {
  if (state.state !== STATES.AWAITING_HUMAN) {
    return { state, deliveries: [], error: `no human decision expected in ${state.state}` };
  }
  const s = { ...state };
  s.humanDecisions = [
    ...state.humanDecisions,
    { ...decision, ts: Date.now() },
  ];
  if (decision.action === "approve") {
    s.state = STATES.DONE;
    s.finishedAt = Date.now();
    s.terminalReason = "human approved task completion";
    return { state: s, deliveries: [], terminal: "done" };
  }
  if (decision.action === "reject" || decision.action === "extend") {
    s.state = STATES.RESEARCHER_DECOMPOSE;
    const text =
      decision.text ||
      (decision.action === "extend"
        ? "The human granted additional budget; continue the task and address any remaining gaps."
        : "The human rejected task completion; continue working on the remaining gaps.");
    const envelope = {
      role: "human",
      kind: "human_message",
      goalId: s.currentGoalId,
      text,
      payload: { action: decision.action },
      ts: Date.now(),
    };
    return { state: s, deliveries: [delivery("researcher", envelope)] };
  }
  return { state, deliveries: [], error: `unknown human action: ${decision.action}` };
}

/**
 * A child subagent finished: resume this (parent) session in the state the
 * proposal was made from and hand the report to its researcher.
 * @param {object} state parent session state (SUBAGENT_RUNNING)
 * @param {object} envelope the report envelope delivered to the researcher
 */
export function applySubagentDone(state, envelope) {
  if (state.state !== STATES.SUBAGENT_RUNNING) {
    return { state, deliveries: [], error: `no subagent is running in ${state.state}` };
  }
  const s = {
    ...state,
    state: state.subagentReturnState || STATES.RESEARCHER_EXECUTE,
    subagentReturnState: null,
  };
  return { state: s, deliveries: [delivery("researcher", envelope)] };
}

export function markAborted(state, reason) {
  return {
    state: {
      ...state,
      state: STATES.ABORTED,
      finishedAt: Date.now(),
      terminalReason: reason,
    },
    deliveries: [],
    terminal: "aborted",
  };
}
