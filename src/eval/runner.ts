/**
 * The suite runner.
 *
 * The runner owns budgets, repeats and timing. It owns nothing about how a task
 * is actually attempted: the agent under test arrives as an injected
 * `TaskExecutor`, a plain function, so that Craftonomous can evaluate an agent
 * it knows nothing about, which is the point of an agent-agnostic substrate,
 * and the thing every surveyed benchmark gave up by baking its own agent loop
 * into the harness.
 */

import type { Clock } from '../runtime/clock.js';
import type { TaskOutcome } from './scoring.js';
import { scoreByTask, scoreOutcome, scoreSuite } from './scoring.js';
import type { ScoredOutcome, SuiteScore, TaskScore } from './scoring.js';
import type { Task, TaskManifest } from './task.js';
import { hashManifest } from './task.js';

/** What the executor is told about the attempt it is being asked to make. */
export interface AttemptContext {
  /** 0-based index of this repeat of the task. */
  readonly repeat: number;
  /** Deterministic seed for this (manifest, task, repeat) triple. */
  readonly seed: number;
  /** Aborted when the attempt's time budget expires. */
  readonly signal: AbortSignal;
  /** Milliseconds the attempt is allowed, after any option override. */
  readonly timeBudgetMs: number;
}

/**
 * The agent under test, as a structural interface. Anything that can attempt a
 * task and report a deterministic outcome qualifies: an MCP client, an
 * in-process reference agent, a replay of a recorded run, or a stub in a test.
 */
export type TaskExecutor = (
  task: Task,
  context: AttemptContext,
) => Promise<TaskOutcome>;

export interface RunOptions {
  /** Time source. Never `Date.now()`: a run must replay identically. */
  readonly clock: Clock;
  /** How many times to attempt each task. Defaults to 1. */
  readonly repeats?: number;
  /** Mixed into every seed, so a whole run can be re-derived from one number. */
  readonly seed?: number;
  /** Overrides every task's own time budget. For smoke runs and tests. */
  readonly timeBudgetMsOverride?: number;
  /** Called as each attempt completes, for progress reporting. */
  readonly onAttempt?: (attempt: AttemptRecord) => void;
  /** Aborts the whole run; remaining attempts are not started. */
  readonly signal?: AbortSignal;
}

/** One attempt at one task, with everything needed to re-run it. */
export interface AttemptRecord {
  readonly taskId: string;
  readonly repeat: number;
  readonly seed: number;
  readonly outcome: TaskOutcome;
  readonly scored: ScoredOutcome;
}

export interface SuiteRun {
  readonly manifestName: string;
  readonly manifestVersion: string;
  readonly manifestHash: string;
  readonly repeats: number;
  readonly seed: number;
  readonly attempts: readonly AttemptRecord[];
  readonly byTask: readonly TaskScore[];
  readonly score: SuiteScore;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/**
 * FNV-1a over the run's identity. A hash rather than a PRNG stream so that any
 * one attempt's seed can be recomputed in isolation, without replaying the
 * attempts before it.
 */
function deriveSeed(
  manifestHash: string,
  taskId: string,
  repeat: number,
  base: number,
): number {
  const key = `${manifestHash}:${taskId}:${repeat}:${base}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function timeoutOutcome(durationMs: number, detail: string): TaskOutcome {
  return { kind: 'timeout', steps: 0, durationMs, detail };
}

/**
 * Runs one attempt under its time budget.
 *
 * The budget is enforced by the harness rather than trusted to the executor: an
 * agent that hangs must produce a `timeout` row, not a missing one, or the
 * suite silently measures a smaller task set than it claims to.
 */
async function runAttempt(
  task: Task,
  executor: TaskExecutor,
  options: RunOptions,
  repeat: number,
  seed: number,
): Promise<TaskOutcome> {
  const { clock } = options;
  const timeBudgetMs =
    options.timeBudgetMsOverride ?? task.budget.maxDurationMs;
  const controller = new AbortController();
  const startedAt = clock.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<TaskOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`task ${task.id} exceeded ${timeBudgetMs}ms`));
      resolve(
        timeoutOutcome(
          clock.now() - startedAt,
          `time budget of ${timeBudgetMs}ms exhausted`,
        ),
      );
    }, timeBudgetMs);
  });

  const context: AttemptContext = {
    repeat,
    seed,
    signal: controller.signal,
    timeBudgetMs,
  };

  try {
    const outcome = await Promise.race([
      executor(task, context).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const errored: TaskOutcome = {
          kind: 'error',
          steps: 0,
          durationMs: clock.now() - startedAt,
          detail: `executor threw: ${message}`,
        };
        return errored;
      }),
      expiry,
    ]);
    // A step budget is a budget like any other: overrunning it is a timeout,
    // whatever the executor chose to call it.
    if (outcome.steps > task.budget.maxSteps) {
      return timeoutOutcome(
        outcome.durationMs,
        `step budget of ${task.budget.maxSteps} exceeded (${outcome.steps})`,
      );
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

export async function runSuite(
  manifest: TaskManifest,
  executor: TaskExecutor,
  options: RunOptions,
): Promise<SuiteRun> {
  const repeats = options.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new RangeError(`repeats must be a positive integer, got ${repeats}`);
  }
  const base = options.seed ?? 0;
  const manifestHash = hashManifest(manifest);
  const startedAt = options.clock.now();
  const attempts: AttemptRecord[] = [];

  outer: for (const task of manifest.tasks) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      if (options.signal?.aborted === true) break outer;
      const seed = deriveSeed(manifestHash, task.id, repeat, base);
      const outcome = await runAttempt(task, executor, options, repeat, seed);
      const record: AttemptRecord = {
        taskId: task.id,
        repeat,
        seed,
        outcome,
        scored: scoreOutcome(task, outcome),
      };
      attempts.push(record);
      options.onAttempt?.(record);
    }
  }

  const scored = attempts.map((a) => a.scored);
  return {
    manifestName: manifest.name,
    manifestVersion: manifest.version,
    manifestHash,
    repeats,
    seed: base,
    attempts,
    byTask: scoreByTask(manifest, scored),
    score: scoreSuite(scored),
    startedAt,
    finishedAt: options.clock.now(),
  };
}
