/**
 * Versioned task definitions.
 *
 * The survey behind this project found that published Minecraft-agent
 * benchmarks are, in practice, unreproducible: one reports that its own
 * baselines were invalidated by a bug found after publication, several score
 * with a VLM judge that will be deprecated out from under the numbers, and the
 * task suites that are pinned at all are pinned to a Minecraft version and a
 * JDK from 2021. In every case the failure is the same shape — a score was
 * published without the exact conditions that produced it.
 *
 * So a task here carries a version, a suite carries a version, and a manifest
 * carries a content hash. A result can then name precisely the task set it was
 * earned on, and a reader can tell whether two numbers were ever comparable.
 */

import { createHash } from 'node:crypto';

/**
 * Coarse difficulty band. Deliberately not a number: a rank invites averaging,
 * and an averaged difficulty means nothing.
 */
export type Difficulty = 'trivial' | 'easy' | 'moderate' | 'hard' | 'brutal';

export const DIFFICULTIES: readonly Difficulty[] = [
  'trivial',
  'easy',
  'moderate',
  'hard',
  'brutal',
];

/** A step/time budget. Exceeding either ends the attempt as a timeout. */
export interface Budget {
  /** Maximum skill invocations the agent may spend. */
  readonly maxSteps: number;
  /** Maximum wall-clock milliseconds the attempt may take. */
  readonly maxDurationMs: number;
}

export interface Task {
  /** Stable identifier. Never reused for a different task. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /**
   * Version of *this task*. Bump whenever the goal, the budget or the required
   * profile changes, because any of those changes what a score means.
   */
  readonly version: string;
  /** Version of the suite this task was authored for. */
  readonly suiteVersion: string;
  readonly tags: readonly string[];
  readonly difficulty: Difficulty;
  /**
   * Human-readable description of the goal predicate. The predicate itself is
   * evaluated by the executor against real game state; it is described here so
   * that a task definition is legible without reading code. It is deliberately
   * *not* a natural-language rubric for a model judge — nothing in this module
   * scores with a model.
   */
  readonly goal: string;
  readonly budget: Budget;
  /**
   * Name of the perception profile this task must be run under. A result
   * earned under a different profile is a different result; the report refuses
   * to print a score without the profile beside it.
   */
  readonly profile: string;
  /**
   * True when the goal cannot be satisfied at all. Refusing an impossible goal
   * is the correct behaviour and scores as success; claiming to have completed
   * one is, by definition, a false claim.
   */
  readonly impossible: boolean;
}

/** A named, versioned, ordered collection of tasks. */
export interface TaskManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tasks: readonly Task[];
}

/**
 * Builds a task, filling in the suite version so that suite files stay
 * declarative data rather than repeating themselves.
 */
export function defineTask(
  suiteVersion: string,
  spec: Omit<Task, 'suiteVersion'>,
): Task {
  if (spec.id.trim() === '') throw new Error('task id must not be empty');
  if (spec.version.trim() === '') {
    throw new Error(`task ${spec.id}: version must not be empty`);
  }
  if (spec.budget.maxSteps <= 0 || spec.budget.maxDurationMs <= 0) {
    throw new RangeError(`task ${spec.id}: budget must be positive`);
  }
  return { ...spec, suiteVersion };
}

/** Builds a manifest, rejecting duplicate ids and suite-version drift. */
export function defineManifest(spec: TaskManifest): TaskManifest {
  const seen = new Set<string>();
  for (const task of spec.tasks) {
    if (seen.has(task.id)) {
      throw new Error(`duplicate task id in manifest ${spec.name}: ${task.id}`);
    }
    seen.add(task.id);
    if (task.suiteVersion !== spec.version) {
      throw new Error(
        `task ${task.id} declares suite version ${task.suiteVersion}, ` +
          `manifest ${spec.name} is ${spec.version}`,
      );
    }
  }
  return spec;
}

/** The identity line a single task contributes to the manifest hash. */
function taskIdentity(task: Task): string {
  return `${task.id}@${task.version}`;
}

/**
 * Stable content hash over the manifest's identity and its task set.
 *
 * Order-independent over the tasks — reordering a suite does not change what
 * was measured — but sensitive to a task's id or version, because either of
 * those changing means the suite is no longer the one an old score was earned
 * on. Truncated to 16 hex characters: long enough to name a suite, short
 * enough to sit in a printed table.
 */
export function hashManifest(manifest: TaskManifest): string {
  const lines = manifest.tasks.map(taskIdentity).sort();
  const payload = [
    `manifest:${manifest.name}`,
    `version:${manifest.version}`,
    ...lines.map((l) => `task:${l}`),
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/** Convenience: every distinct perception profile a manifest demands. */
export function requiredProfiles(manifest: TaskManifest): readonly string[] {
  return [...new Set(manifest.tasks.map((t) => t.profile))].sort();
}

export function findTask(
  manifest: TaskManifest,
  id: string,
): Task | undefined {
  return manifest.tasks.find((t) => t.id === id);
}
