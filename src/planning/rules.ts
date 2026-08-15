/**
 * Learning action preconditions from an agent's own failures.
 *
 * WALL-E's result is that an agent which mines rules from its failed attempts
 * (propose candidate preconditions, refine them, then prune by maximum
 * coverage) needs far fewer attempts than one that only reflects in prose. Its
 * demonstration is a 2D Crafter clone; whether it survives contact with real
 * Minecraft preconditions is open, and is the reason this module exists. The
 * pipeline shape is taken from the paper's description; the implementation is
 * independent.
 *
 * The design commitment here: a rule is a *testable* object, not a sentence. A
 * rule carries a machine-checkable condition alongside its description, so
 * `apply` can veto an action before the agent commits to it. A learned rule
 * that can only be read by a model is a note, not a rule.
 */

/** Flat, comparable world facts. Deliberately not nested: a precondition over a
 *  deep object is not something we can honestly claim to have learned. */
export type State = Readonly<Record<string, string | number | boolean>>;

export type ConditionOp = 'eq' | 'ne' | 'gte' | 'lte' | 'present' | 'absent';

export interface Condition {
  /** Readable form, for logs and for feeding back to a model. */
  readonly description: string;
  readonly key: string;
  readonly op: ConditionOp;
  /** Absent for `present` / `absent`. */
  readonly value?: string | number | boolean;
}

export interface Transition {
  readonly action: string;
  readonly before: State;
  readonly after: State;
  readonly succeeded: boolean;
  readonly failureReason?: string;
}

export interface Rule {
  readonly id: string;
  readonly action: string;
  /** What must hold in the state *before* the action for it to work. */
  readonly condition: Condition;
  /** What the action is believed to bring about when it does work. */
  readonly effect: string;
  /** Failed transitions this rule explains. */
  readonly support: number;
  /**
   * Of every observed transition that violated this precondition, the fraction
   * that actually failed. 1.0 means the violation has never been survived.
   */
  readonly confidence: number;
}

/** A rule before support and confidence have been measured against the log. */
export interface RuleDraft {
  readonly action: string;
  readonly condition: Condition;
  readonly effect: string;
}

export interface ProposalInput {
  readonly action: string;
  /** Failed transitions for this action. */
  readonly failures: readonly Transition[];
  /** Successful transitions for this action, for contrast. */
  readonly successes: readonly Transition[];
}

/** Stage a. An LLM in production; `contrastiveProposer` offline. */
export type Proposer = (
  input: ProposalInput,
) => Promise<readonly RuleDraft[]> | readonly RuleDraft[];

/** Stage b. Merge and generalise. `mergeRefiner` is the offline default. */
export type Refiner = (
  drafts: readonly RuleDraft[],
  transitions: readonly Transition[],
) => Promise<readonly RuleDraft[]> | readonly RuleDraft[];

export function conditionId(action: string, c: Condition): string {
  const v = c.value === undefined ? '' : String(c.value);
  return `${action}::${c.key}:${c.op}${v === '' ? '' : `:${v}`}`;
}

/** Does the condition hold in this state? */
export function testCondition(c: Condition, state: State): boolean {
  const has = Object.prototype.hasOwnProperty.call(state, c.key);
  const actual = state[c.key];
  switch (c.op) {
    case 'present':
      return has;
    case 'absent':
      return !has;
    case 'eq':
      return has && actual === c.value;
    case 'ne':
      return !has || actual !== c.value;
    case 'gte':
      return has && typeof actual === 'number' && actual >= (c.value as number);
    case 'lte':
      return has && typeof actual === 'number' && actual <= (c.value as number);
  }
}

function describe(key: string, op: ConditionOp, value?: unknown): string {
  switch (op) {
    case 'present':
      return `${key} is known`;
    case 'absent':
      return `${key} is not set`;
    case 'eq':
      return `${key} == ${String(value)}`;
    case 'ne':
      return `${key} != ${String(value)}`;
    case 'gte':
      return `${key} >= ${String(value)}`;
    case 'lte':
      return `${key} <= ${String(value)}`;
  }
}

export function condition(
  key: string,
  op: ConditionOp,
  value?: string | number | boolean,
): Condition {
  const base = { description: describe(key, op, value), key, op };
  return value === undefined ? base : { ...base, value };
}

/* ------------------------------------------------------------------ */
/* Stage a: propose                                                    */
/* ------------------------------------------------------------------ */

/**
 * The offline proposer: contrast the states before failures against the states
 * before successes, and nominate every fact that separates them.
 *
 * This is genuinely a learner, not a stub: it is what the tests exercise and
 * what runs when no model is wired up. It over-proposes on purpose; separating
 * the real precondition from the coincidence is the job of stages b and c.
 */
export const contrastiveProposer: Proposer = ({
  action,
  failures,
  successes,
}) => {
  if (failures.length === 0) return [];
  const drafts: RuleDraft[] = [];
  const emitted = new Set<string>();
  const effect = summariseEffect(successes);

  const keys = new Set<string>();
  for (const t of [...failures, ...successes]) {
    for (const k of Object.keys(t.before)) keys.add(k);
  }

  const push = (c: Condition): void => {
    const id = conditionId(action, c);
    if (emitted.has(id)) return;
    emitted.add(id);
    drafts.push({ action, condition: c, effect });
  };

  for (const key of [...keys].sort()) {
    const succVals = successes
      .map((t) => t.before[key])
      .filter((v) => v !== undefined);
    const failVals = failures.map((t) => t.before[key]);

    // Presence: held in every success, missing in at least one failure.
    if (
      successes.length > 0 &&
      succVals.length === successes.length &&
      failVals.some((v) => v === undefined)
    ) {
      push(condition(key, 'present'));
    }

    const numericSucc = succVals.filter(
      (v): v is number => typeof v === 'number',
    );
    if (numericSucc.length > 0 && numericSucc.length === succVals.length) {
      const floor = Math.min(...numericSucc);
      if (
        failVals.some((v) => typeof v === 'number' && v < floor) ||
        failVals.some((v) => v === undefined)
      ) {
        push(condition(key, 'gte', floor));
      }
    }

    // Categorical: one value across all successes, contradicted by a failure.
    const distinct = [...new Set(succVals)];
    const only = distinct[0];
    if (
      distinct.length === 1 &&
      only !== undefined &&
      succVals.length === successes.length &&
      successes.length > 0 &&
      failVals.some((v) => v !== only)
    ) {
      push(condition(key, 'eq', only));
    }

    // No successes to contrast with: a fact shared by every failure is at least
    // a hypothesis worth testing, phrased as its negation.
    if (successes.length === 0) {
      const distinctFail = [...new Set(failVals)];
      const shared = distinctFail[0];
      if (
        distinctFail.length === 1 &&
        shared !== undefined &&
        failures.length > 1
      ) {
        push(condition(key, 'ne', shared));
      }
    }
  }
  return drafts;
};

function summariseEffect(successes: readonly Transition[]): string {
  const first = successes[0];
  if (!first) return 'action succeeds';
  const changed = Object.keys(first.after).filter(
    (k) => first.after[k] !== first.before[k],
  );
  return changed.length > 0
    ? `changes ${changed.sort().join(', ')}`
    : 'action succeeds';
}

/* ------------------------------------------------------------------ */
/* Stage b: refine                                                     */
/* ------------------------------------------------------------------ */

/**
 * The offline refiner: deduplicate identical drafts, then generalise families
 * of numeric thresholds on the same key down to the single threshold that
 * separates the log best.
 *
 * "Best" is the threshold with the highest confidence, ties broken toward the
 * most permissive value: a precondition that vetoes too much is worse than one
 * that vetoes too little, because the agent can recover from a surprise but
 * cannot recover from never trying.
 */
export const mergeRefiner: Refiner = (drafts, transitions) => {
  const byId = new Map<string, RuleDraft>();
  for (const d of drafts) {
    const id = conditionId(d.action, d.condition);
    if (!byId.has(id)) byId.set(id, d);
  }

  const numericFamilies = new Map<string, RuleDraft[]>();
  const out: RuleDraft[] = [];
  for (const d of byId.values()) {
    if (
      (d.condition.op === 'gte' || d.condition.op === 'lte') &&
      typeof d.condition.value === 'number'
    ) {
      const famKey = `${d.action}::${d.condition.key}::${d.condition.op}`;
      const fam = numericFamilies.get(famKey) ?? [];
      fam.push(d);
      numericFamilies.set(famKey, fam);
    } else {
      out.push(d);
    }
  }

  for (const fam of numericFamilies.values()) {
    let best: RuleDraft | undefined;
    let bestScore = -1;
    for (const d of fam) {
      const m = measure(d, transitions);
      const score = m.confidence * 1000 + m.support;
      const better =
        score > bestScore ||
        (score === bestScore &&
          best !== undefined &&
          isMorePermissive(d, best));
      if (better) {
        best = d;
        bestScore = score;
      }
    }
    if (best) out.push(best);
  }
  return out;
};

function isMorePermissive(a: RuleDraft, b: RuleDraft): boolean {
  const av = a.condition.value;
  const bv = b.condition.value;
  if (typeof av !== 'number' || typeof bv !== 'number') return false;
  return a.condition.op === 'gte' ? av < bv : av > bv;
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

export interface Measurement {
  readonly support: number;
  readonly confidence: number;
  /** Transitions that violated the precondition and nonetheless succeeded. */
  readonly counterexamples: number;
  /** Ids (indices) of the failed transitions this rule explains. */
  readonly explains: readonly number[];
}

/**
 * Score a draft against the log.
 *
 * A precondition rule explains a failure when the failure happened while the
 * condition did not hold. Confidence asks the sharper question: of every
 * transition where the condition did not hold, how often did the action in fact
 * fail? A rule that is violated freely without consequence scores near zero and
 * is discarded, which is what keeps coincidence out of the rule set.
 */
export function measure(
  draft: RuleDraft,
  transitions: readonly Transition[],
): Measurement {
  const explains: number[] = [];
  let violations = 0;
  let counterexamples = 0;
  for (const [i, t] of transitions.entries()) {
    if (t.action !== draft.action) continue;
    if (testCondition(draft.condition, t.before)) continue;
    violations += 1;
    if (t.succeeded) counterexamples += 1;
    else explains.push(i);
  }
  return {
    support: explains.length,
    confidence: violations === 0 ? 0 : explains.length / violations,
    counterexamples,
    explains,
  };
}

export function toRule(
  draft: RuleDraft,
  transitions: readonly Transition[],
): Rule {
  const m = measure(draft, transitions);
  return {
    id: conditionId(draft.action, draft.condition),
    action: draft.action,
    condition: draft.condition,
    effect: draft.effect,
    support: m.support,
    confidence: m.confidence,
  };
}

/* ------------------------------------------------------------------ */
/* Stage c: prune                                                      */
/* ------------------------------------------------------------------ */

export interface PruneOptions {
  /** Drop rules below this confidence before selecting. Default 0.6. */
  readonly minConfidence?: number;
  /** Drop rules explaining fewer failures than this. Default 1. */
  readonly minSupport?: number;
  /** Stop once this fraction of explicable failures is covered. Default 1. */
  readonly targetCoverage?: number;
  /** Hard cap on the returned rule set. Default Infinity. */
  readonly maxRules?: number;
}

export interface PruneResult {
  readonly rules: readonly Rule[];
  /** Failed transitions covered by the selected set. */
  readonly covered: number;
  /** Failed transitions any candidate could have covered. */
  readonly coverable: number;
}

/**
 * Maximum coverage by the greedy algorithm: repeatedly take the rule that
 * explains the most so-far-unexplained failures.
 *
 * **This is approximate.** Maximum coverage is NP-hard; greedy is the standard
 * (1 - 1/e) ≈ 0.632 approximation and can return more rules than the true
 * optimum. That is an accepted trade: the alternative is an exact solve over a
 * set that grows with every failure the agent ever logs. Ties break toward
 * higher confidence, then toward a stable id, so the output is deterministic.
 * A rule set that reshuffles between identical runs is not auditable.
 *
 * Pure: no injected model, no I/O. Stages a and b may be a model's opinion;
 * this stage is arithmetic, and is the one the tests pin down hardest.
 */
export function prune(
  drafts: readonly RuleDraft[],
  transitions: readonly Transition[],
  options: PruneOptions = {},
): PruneResult {
  const minConfidence = options.minConfidence ?? 0.6;
  const minSupport = options.minSupport ?? 1;
  const targetCoverage = options.targetCoverage ?? 1;
  const maxRules = options.maxRules ?? Number.POSITIVE_INFINITY;

  const candidates = drafts
    .map((d) => ({ draft: d, m: measure(d, transitions) }))
    .filter(
      (c) =>
        c.m.support >= minSupport &&
        c.m.confidence >= minConfidence &&
        c.m.support > 0,
    );

  const universe = new Set<number>();
  for (const c of candidates) for (const i of c.m.explains) universe.add(i);

  const uncovered = new Set(universe);
  const chosen: Rule[] = [];
  const used = new Set<string>();
  const goal = Math.ceil(universe.size * targetCoverage);

  while (
    universe.size - uncovered.size < goal &&
    chosen.length < maxRules &&
    uncovered.size > 0
  ) {
    let best:
      { draft: RuleDraft; gain: number; conf: number; id: string } | undefined;
    for (const c of candidates) {
      const id = conditionId(c.draft.action, c.draft.condition);
      if (used.has(id)) continue;
      const gain = c.m.explains.filter((i) => uncovered.has(i)).length;
      if (gain === 0) continue;
      const better =
        best === undefined ||
        gain > best.gain ||
        (gain === best.gain && c.m.confidence > best.conf) ||
        (gain === best.gain && c.m.confidence === best.conf && id < best.id);
      if (better) best = { draft: c.draft, gain, conf: c.m.confidence, id };
    }
    if (!best) break;
    used.add(best.id);
    chosen.push(toRule(best.draft, transitions));
    for (const c of candidates) {
      if (conditionId(c.draft.action, c.draft.condition) !== best.id) continue;
      for (const i of c.m.explains) uncovered.delete(i);
    }
  }

  return {
    rules: chosen,
    covered: universe.size - uncovered.size,
    coverable: universe.size,
  };
}

/* ------------------------------------------------------------------ */
/* Veto                                                                */
/* ------------------------------------------------------------------ */

export interface RuleVerdict {
  /** False when a learned precondition is violated. */
  readonly allowed: boolean;
  readonly violations: readonly Rule[];
  /** One line explaining the veto, empty when allowed. */
  readonly reason: string;
}

/**
 * Check a proposed action against the learned rules *before* acting.
 *
 * This is the payoff. Reflection after the fact costs an attempt every time;
 * a checkable precondition costs nothing and refuses the attempt outright. The
 * verdict names the rules that fired so a planner can repair the state instead
 * of merely retrying.
 */
export function apply(
  rules: readonly Rule[],
  action: string,
  state: State,
): RuleVerdict {
  const violations = rules
    .filter((r) => r.action === action)
    .filter((r) => !testCondition(r.condition, state))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  return {
    allowed: violations.length === 0,
    violations,
    reason:
      violations.length === 0
        ? ''
        : `${action} blocked: ${violations
            .map((v) => `requires ${v.condition.description}`)
            .join('; ')}`,
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface RuleMinerOptions extends PruneOptions {
  /** Stage a. Defaults to the offline contrastive proposer. */
  readonly proposer?: Proposer;
  /** Stage b. Defaults to the offline merge/generalise refiner. */
  readonly refiner?: Refiner;
}

export interface MiningReport {
  readonly rules: readonly Rule[];
  readonly proposed: number;
  readonly refined: number;
  readonly covered: number;
  readonly coverable: number;
}

/** propose → refine → prune, over a transition log. */
export class RuleMiner {
  readonly #proposer: Proposer;
  readonly #refiner: Refiner;
  readonly #options: PruneOptions;

  constructor(options: RuleMinerOptions = {}) {
    this.#proposer = options.proposer ?? contrastiveProposer;
    this.#refiner = options.refiner ?? mergeRefiner;
    this.#options = options;
  }

  async mine(transitions: readonly Transition[]): Promise<MiningReport> {
    const actions = [...new Set(transitions.map((t) => t.action))].sort();
    const proposed: RuleDraft[] = [];
    for (const action of actions) {
      const forAction = transitions.filter((t) => t.action === action);
      const failures = forAction.filter((t) => !t.succeeded);
      if (failures.length === 0) continue;
      const drafts = await this.#proposer({
        action,
        failures,
        successes: forAction.filter((t) => t.succeeded),
      });
      proposed.push(...drafts);
    }

    const refined = await this.#refiner(proposed, transitions);
    const result = prune(refined, transitions, this.#options);
    return {
      rules: result.rules,
      proposed: proposed.length,
      refined: refined.length,
      covered: result.covered,
      coverable: result.coverable,
    };
  }
}
