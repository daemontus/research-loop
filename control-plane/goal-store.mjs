/**
 * Harness-owned goals (see docs/PROTOCOL.md, "Goals").
 *
 * Every session that plans (main) or is given subgoals (orchestrator) owns an
 * ordered goal list. Goals are created and changed only through validated
 * operations here; agents read them via the list_goals / read_goal tools.
 * Pure in-memory state: persistence is the control-plane log that the engine
 * replays.
 */

export const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GOAL_STATUS = ["planned", "in_progress", "done", "aborted"];

const MAX_TEXT = 20000;

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v) {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
}

/** Normalise one goal from a tool payload (no validation). */
export function normalizeGoal(raw) {
  return {
    id: str(raw?.id),
    title: str(raw?.title),
    description: str(raw?.description).slice(0, MAX_TEXT),
    acceptance: strList(raw?.acceptance),
    skills: strList(raw?.skills),
  };
}

export class GoalStore {
  constructor() {
    /** owner session id -> { version, goals: Goal[] } */
    this.lists = new Map();
    /** goal id -> Goal (every goal currently in some list) */
    this.byId = new Map();
  }

  list(owner) {
    return this.lists.get(owner)?.goals || [];
  }

  version(owner) {
    return this.lists.get(owner)?.version || 0;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** First goal still to be worked on, or null. */
  current(owner) {
    return this.list(owner).find((g) => g.status === "planned") || null;
  }

  planned(owner) {
    return this.list(owner).filter((g) => g.status === "planned");
  }

  /**
   * Validate a proposed goal list. `replacing` (plan changes) lets the new list
   * reuse ids of the owner's planned goals it replaces; `prefix` requires every
   * id to start with it (subgoals of a goal); `allowEmpty` permits [].
   * @returns {string|null} error
   */
  validate(rawGoals, { owner, prefix = null, replacing = false, allowEmpty = false, minCount = 1 } = {}) {
    if (!Array.isArray(rawGoals)) return "`goals` must be a list of goals";
    if (!allowEmpty && rawGoals.length < minCount) {
      return minCount > 1 ? `at least ${minCount} goals are required` : "the goal list is empty";
    }
    const replaceable = new Set(replacing ? this.planned(owner).map((g) => g.id) : []);
    const seen = new Set();
    for (const [i, raw] of rawGoals.entries()) {
      const g = normalizeGoal(raw);
      const where = `goal #${i + 1}${g.id ? ` (${g.id})` : ""}`;
      if (!GOAL_ID_RE.test(g.id)) {
        return `${where}: id must match ${GOAL_ID_RE.source} (letters, digits, '.', '_', '-')`;
      }
      if (prefix && !g.id.startsWith(`${prefix}.`)) {
        return `${where}: subgoal ids must start with '${prefix}.' (e.g. ${prefix}.1)`;
      }
      if (seen.has(g.id)) return `${where}: duplicate id in this list`;
      seen.add(g.id);
      if (this.byId.has(g.id) && !replaceable.has(g.id)) {
        const existing = this.byId.get(g.id);
        return `${where}: id is already used by an existing goal (${existing.status}); ids are unique across the run`;
      }
      if (!g.title) return `${where}: title is required`;
      if (!g.description) return `${where}: description is required`;
      if (!g.acceptance.length) return `${where}: at least one acceptance criterion is required`;
    }
    return null;
  }

  #make(raw, owner, ts) {
    return {
      ...normalizeGoal(raw),
      owner,
      status: "planned",
      createdAt: ts,
      startedAt: null,
      finishedAt: null,
      // filled in as the goal is worked on
      childId: null,
      mode: null,
      instructions: "",
      justification: "",
      conditions: [],
      report: "",
      notes: "",
      verdict: "",
      endReason: "",
    };
  }

  /** Register the owner's first plan (validated by the caller). Returns its version. */
  register(owner, rawGoals, ts = Date.now()) {
    const goals = rawGoals.map((g) => this.#make(g, owner, ts));
    this.lists.set(owner, { version: 1, goals });
    for (const g of goals) this.byId.set(g.id, g);
    return 1;
  }

  /** Replace every planned goal of `owner` with `rawGoals`. Returns the new version. */
  replacePlanned(owner, rawGoals, ts = Date.now()) {
    const entry = this.lists.get(owner);
    if (!entry) return this.register(owner, rawGoals, ts);
    for (const g of entry.goals) if (g.status === "planned") this.byId.delete(g.id);
    const kept = entry.goals.filter((g) => g.status !== "planned");
    const added = rawGoals.map((g) => this.#make(g, owner, ts));
    for (const g of added) this.byId.set(g.id, g);
    entry.goals = [...kept, ...added];
    entry.version += 1;
    return entry.version;
  }

  /** Mark every remaining planned goal of `owner` aborted (its session ended). */
  abortPlanned(owner, reason, ts = Date.now()) {
    for (const g of this.planned(owner)) {
      g.status = "aborted";
      g.endReason = reason;
      g.finishedAt = ts;
    }
  }

  /** Done/aborted goals before `goalId` in its owner's list (its siblings so far). */
  finishedBefore(goalId) {
    const goal = this.get(goalId);
    if (!goal) return [];
    const out = [];
    for (const g of this.list(goal.owner)) {
      if (g.id === goalId) break;
      if (g.status === "done" || g.status === "aborted") out.push(g);
    }
    return out;
  }

  /** Plain snapshot of a list (plan version files, UI). */
  snapshot(owner) {
    return this.list(owner).map((g) => ({ ...g }));
  }
}

const STATUS_MARK = { planned: "[ ]", in_progress: "[~]", done: "[x]", aborted: "[-]" };

/** One goal in full, as markdown (read_goal, briefs). */
export function renderGoal(goal, { withOutcome = true, withReport = true } = {}) {
  if (!goal) return "";
  const lines = [`### ${goal.id} — ${goal.title} [${goal.status}]`, "", goal.description, ""];
  if (goal.acceptance.length) lines.push("Acceptance criteria:", ...goal.acceptance.map((a) => `- ${a}`), "");
  if (goal.skills.length) lines.push(`Skills: ${goal.skills.join(", ")}`, "");
  if (goal.childId) {
    lines.push(`Worked on by subagent ${goal.childId} (${goal.mode === "split" ? "split into subgoals" : "in full"}).`, "");
  }
  if (withOutcome) {
    if (goal.endReason) lines.push(`Outcome: ${goal.endReason}`, "");
    if (goal.verdict) lines.push("Advisor verdict:", goal.verdict, "");
    if (goal.notes) lines.push("Notes for later agents:", goal.notes, "");
    if (withReport && goal.report) lines.push("Report:", goal.report, "");
  }
  return lines.join("\n").trim();
}

/** Compact list of goals: `[x] G1 — title`. */
export function renderGoalList(goals, indent = "") {
  return goals.map((g) => `${indent}${STATUS_MARK[g.status] || "[?]"} ${g.id} — ${g.title}`).join("\n");
}
