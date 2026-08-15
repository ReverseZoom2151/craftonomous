/**
 * Deterministic scoring.
 *
 * There is no model in this file and there will not be one. Two of the
 * benchmarks in the survey score with a VLM judge, which makes their published
 * numbers a function of a model that will be deprecated and cannot be
 * re-hosted; nobody can reproduce those results in five years, including their
 * authors. Everything here is arithmetic over recorded outcomes, so the same
 * outcomes always produce the same score.
 */

import type { Task, TaskManifest } from './task.js';

/**
 * How an attempt ended.
 *
 * `refused` is a first-class outcome rather than a species of failure. An agent
 * that says "this cannot be done" is doing something different from an agent
 * that tried and failed, and a suite containing impossible tasks exists
 * precisely to tell those two apart.
 */
export type OutcomeKind =
  /** The agent reports the goal predicate satisfied. */
  | 'success'
  /** The agent finished without satisfying the goal. */
  | 'failure'
  /** The agent declined the task, asserting the goal is unsatisfiable. */
  | 'refused'
  /** The step or time budget ran out. */
  | 'timeout'
  /** The harness or the agent broke: not a measurement of ability. */
  | 'error';

export const OUTCOME_KINDS: readonly OutcomeKind[] = [
  'success',
  'failure',
  'refused',
  'timeout',
  'error',
];

/** What an executor reports back for one attempt at one task. */
export interface TaskOutcome {
  readonly kind: OutcomeKind;
  /** Skill invocations spent. */
  readonly steps: number;
  /** Wall-clock milliseconds, measured against the injected clock. */
  readonly durationMs: number;
  /** Free-text note, never scored. */
  readonly detail?: string;
}

/** An outcome after the task's own rules have been applied to it. */
export interface ScoredOutcome {
  readonly taskId: string;
  readonly impossible: boolean;
  readonly kind: OutcomeKind;
  /** Whether this attempt counts toward the success rate. */
  readonly credited: boolean;
  /**
   * True when the agent claimed to have completed an unsatisfiable goal. Not a
   * mere failure: it is a false report about the world, and worth counting
   * separately from flailing.
   */
  readonly falseClaim: boolean;
  readonly steps: number;
  readonly durationMs: number;
}

/**
 * Whether an outcome earns credit for a task.
 *
 * For an ordinary task, only `success` counts, and a refusal is a wrong answer.
 *
 * For an `impossible` task the polarity flips: `refused` is the only correct
 * answer, `success` is impossible by construction and therefore a false claim,
 * and failing or timing out earns nothing — the agent burned its budget on a
 * goal it should have recognised. An agent that never refuses anything scores
 * zero on every impossible task, which is the whole point of including them.
 */
export function isCredited(task: Task, kind: OutcomeKind): boolean {
  return task.impossible ? kind === 'refused' : kind === 'success';
}

export function scoreOutcome(task: Task, outcome: TaskOutcome): ScoredOutcome {
  return {
    taskId: task.id,
    impossible: task.impossible,
    kind: outcome.kind,
    credited: isCredited(task, outcome.kind),
    falseClaim: task.impossible && outcome.kind === 'success',
    steps: outcome.steps,
    durationMs: outcome.durationMs,
  };
}

/** Aggregate over one slice of a run (all tasks, or one subset of them). */
export interface Aggregate {
  readonly attempts: number;
  readonly credited: number;
  /**
   * Observed rate. Reported for completeness, never for ranking: three out of
   * three is 1.0 and means very little.
   */
  readonly successRate: number;
  /**
   * Wilson score lower bound at 95% confidence. This is the number to rank on.
   */
  readonly confidence: number;
  readonly meanSteps: number;
  readonly meanDurationMs: number;
}

export interface SuiteScore extends Aggregate {
  /** Attempts by outcome kind, across the whole run. */
  readonly byKind: Readonly<Record<OutcomeKind, number>>;
  /** The satisfiable tasks only. */
  readonly possible: Aggregate;
  /** The unsatisfiable tasks only; zero attempts when the suite has none. */
  readonly impossible: Aggregate;
  /** Attempts where an unsatisfiable goal was reported complete. */
  readonly falseClaims: number;
  /**
   * How well the agent tells satisfiable from unsatisfiable goals: the credited
   * rate on possible tasks minus the refusal rate on them, balanced against the
   * refusal rate on impossible ones. Zero when the suite contains no impossible
   * tasks, since there is nothing to discriminate.
   */
  readonly discrimination: number;
}

/** Two-sided z for a 95% confidence interval. */
const Z = 1.959963984540054;

/**
 * Wilson score interval, lower bound.
 *
 * This deliberately mirrors `wilsonLowerBound` in src/skills/reliability.ts
 * rather than importing it. The duplication is intentional: the eval harness
 * must stay usable against any implementation of the substrate, so it takes no
 * dependency on the skill layer. The reasoning is identical in both places — a
 * 3/3 run is not a 100% agent, and the naive rate is maximally wrong exactly
 * when the evidence is thinnest, which is when a new agent is first measured.
 * If one of the two is ever changed, change both.
 */
export function wilsonLowerBound(successes: number, attempts: number): number {
  if (attempts <= 0) return 0;
  if (successes < 0 || successes > attempts) {
    throw new RangeError(
      `successes (${successes}) must lie within 0..${attempts}`,
    );
  }
  const n = attempts;
  const p = successes / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

const EMPTY_AGGREGATE: Aggregate = {
  attempts: 0,
  credited: 0,
  successRate: 0,
  confidence: 0,
  meanSteps: 0,
  meanDurationMs: 0,
};

export function aggregate(outcomes: readonly ScoredOutcome[]): Aggregate {
  const attempts = outcomes.length;
  if (attempts === 0) return EMPTY_AGGREGATE;
  let credited = 0;
  let steps = 0;
  let durationMs = 0;
  for (const o of outcomes) {
    if (o.credited) credited += 1;
    steps += o.steps;
    durationMs += o.durationMs;
  }
  return {
    attempts,
    credited,
    successRate: credited / attempts,
    confidence: wilsonLowerBound(credited, attempts),
    meanSteps: steps / attempts,
    meanDurationMs: durationMs / attempts,
  };
}

function countByKind(
  outcomes: readonly ScoredOutcome[],
): Record<OutcomeKind, number> {
  const counts = Object.fromEntries(
    OUTCOME_KINDS.map((k) => [k, 0]),
  ) as Record<OutcomeKind, number>;
  for (const o of outcomes) counts[o.kind] += 1;
  return counts;
}

export function scoreSuite(outcomes: readonly ScoredOutcome[]): SuiteScore {
  const possibleOutcomes = outcomes.filter((o) => !o.impossible);
  const impossibleOutcomes = outcomes.filter((o) => o.impossible);
  const overall = aggregate(outcomes);
  const possible = aggregate(possibleOutcomes);
  const impossible = aggregate(impossibleOutcomes);

  let falseClaims = 0;
  for (const o of outcomes) if (o.falseClaim) falseClaims += 1;

  let discrimination = 0;
  if (impossibleOutcomes.length > 0 && possibleOutcomes.length > 0) {
    const falseRefusals =
      possibleOutcomes.filter((o) => o.kind === 'refused').length /
      possibleOutcomes.length;
    // Correct refusals of the unsatisfiable, less refusals of the satisfiable.
    discrimination = impossible.successRate - falseRefusals;
  }

  return {
    ...overall,
    byKind: countByKind(outcomes),
    possible,
    impossible,
    falseClaims,
    discrimination,
  };
}

/** Per-task rollup across repeats, for the detail rows of a report. */
export interface TaskScore extends Aggregate {
  readonly taskId: string;
  readonly impossible: boolean;
  readonly byKind: Readonly<Record<OutcomeKind, number>>;
}

/**
 * Rolls attempts up per task, in manifest order. Tasks with no attempts are
 * omitted rather than scored zero, because an unattempted task is missing
 * evidence, not evidence of failure.
 */
export function scoreByTask(
  manifest: TaskManifest,
  outcomes: readonly ScoredOutcome[],
): readonly TaskScore[] {
  const rows: TaskScore[] = [];
  for (const task of manifest.tasks) {
    const mine = outcomes.filter((o) => o.taskId === task.id);
    if (mine.length === 0) continue;
    rows.push({
      taskId: task.id,
      impossible: task.impossible,
      byKind: countByKind(mine),
      ...aggregate(mine),
    });
  }
  return rows;
}
