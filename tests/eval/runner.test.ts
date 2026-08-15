import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/runtime/clock.js';
import { runSuite } from '../../src/eval/runner.js';
import type { AttemptContext, TaskExecutor } from '../../src/eval/runner.js';
import { defineManifest, defineTask } from '../../src/eval/task.js';
import type { Task, TaskManifest } from '../../src/eval/task.js';
import type { TaskOutcome } from '../../src/eval/scoring.js';

function task(
  id: string,
  overrides: Partial<Pick<Task, 'impossible' | 'budget'>> = {},
): Task {
  return defineTask('1.0.0', {
    id,
    title: id,
    description: id,
    version: '1.0.0',
    tags: [],
    difficulty: 'easy',
    goal: id,
    budget: overrides.budget ?? { maxSteps: 100, maxDurationMs: 10_000 },
    profile: 'fair-play',
    impossible: overrides.impossible ?? false,
  });
}

function manifest(tasks: readonly Task[]): TaskManifest {
  return defineManifest({
    name: 'runner-demo',
    version: '1.0.0',
    description: 'runner demo',
    tasks,
  });
}

const succeed: TaskExecutor = async () => ({
  kind: 'success',
  steps: 3,
  durationMs: 50,
});

describe('runSuite', () => {
  it('runs every task once by default', async () => {
    const run = await runSuite(manifest([task('a'), task('b')]), succeed, {
      clock: new ManualClock(),
    });
    expect(run.attempts).toHaveLength(2);
    expect(run.score.credited).toBe(2);
    expect(run.byTask).toHaveLength(2);
  });

  it('honours repeats, running each task N times', async () => {
    const seen: string[] = [];
    const executor: TaskExecutor = async (t, ctx) => {
      seen.push(`${t.id}#${ctx.repeat}`);
      return { kind: 'success', steps: 1, durationMs: 1 };
    };
    const run = await runSuite(manifest([task('a'), task('b')]), executor, {
      clock: new ManualClock(),
      repeats: 3,
    });
    expect(run.repeats).toBe(3);
    expect(run.attempts).toHaveLength(6);
    expect(seen).toEqual([
      'a#0',
      'a#1',
      'a#2',
      'b#0',
      'b#1',
      'b#2',
    ]);
    expect(run.score.attempts).toBe(6);
  });

  it('rejects a nonsensical repeat count', async () => {
    await expect(
      runSuite(manifest([task('a')]), succeed, {
        clock: new ManualClock(),
        repeats: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('gives every attempt a distinct, reproducible seed', async () => {
    const seeds: number[] = [];
    const executor: TaskExecutor = async (_t, ctx: AttemptContext) => {
      seeds.push(ctx.seed);
      return { kind: 'success', steps: 1, durationMs: 1 };
    };
    const m = manifest([task('a'), task('b')]);
    const first = await runSuite(m, executor, {
      clock: new ManualClock(),
      repeats: 2,
      seed: 7,
    });
    const captured = [...seeds];
    seeds.length = 0;
    const second = await runSuite(m, executor, {
      clock: new ManualClock(),
      repeats: 2,
      seed: 7,
    });
    expect(seeds).toEqual(captured);
    expect(new Set(seeds).size).toBe(4);
    expect(first.attempts.map((a) => a.seed)).toEqual(
      second.attempts.map((a) => a.seed),
    );

    seeds.length = 0;
    await runSuite(m, executor, {
      clock: new ManualClock(),
      repeats: 2,
      seed: 8,
    });
    expect(seeds).not.toEqual(captured);
  });

  it('times out a task that hangs, and aborts its signal', async () => {
    let aborted = false;
    const hang: TaskExecutor = (_t, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<TaskOutcome>(() => {
        /* never settles */
      });
    };
    const run = await runSuite(
      manifest([task('slow', { budget: { maxSteps: 10, maxDurationMs: 20 } })]),
      hang,
      { clock: new ManualClock() },
    );
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]?.outcome.kind).toBe('timeout');
    expect(aborted).toBe(true);
    expect(run.score.credited).toBe(0);
  });

  it('does not time out a task that finishes inside its budget', async () => {
    const quick: TaskExecutor = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { kind: 'success', steps: 1, durationMs: 1 };
    };
    const run = await runSuite(
      manifest([
        task('quick', { budget: { maxSteps: 10, maxDurationMs: 500 } }),
      ]),
      quick,
      { clock: new ManualClock() },
    );
    expect(run.attempts[0]?.outcome.kind).toBe('success');
  });

  it('treats a blown step budget as a timeout however it was reported', async () => {
    const overspend: TaskExecutor = async () => ({
      kind: 'success',
      steps: 999,
      durationMs: 1,
    });
    const run = await runSuite(
      manifest([
        task('greedy', { budget: { maxSteps: 5, maxDurationMs: 5000 } }),
      ]),
      overspend,
      { clock: new ManualClock() },
    );
    expect(run.attempts[0]?.outcome.kind).toBe('timeout');
    expect(run.attempts[0]?.outcome.detail).toMatch(/step budget/);
  });

  it('records a thrown executor as an error rather than losing the row', async () => {
    const boom: TaskExecutor = async () => {
      throw new Error('mineflayer disconnected');
    };
    const run = await runSuite(manifest([task('a'), task('b')]), boom, {
      clock: new ManualClock(),
    });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0]?.outcome.kind).toBe('error');
    expect(run.attempts[0]?.outcome.detail).toMatch(/mineflayer disconnected/);
  });

  it('measures duration from the injected clock, never Date.now()', async () => {
    const clock = new ManualClock(1_000);
    const ticking: TaskExecutor = async () => {
      clock.advance(250);
      return { kind: 'success', steps: 1, durationMs: 250 };
    };
    const run = await runSuite(manifest([task('a'), task('b')]), ticking, {
      clock,
    });
    expect(run.startedAt).toBe(1_000);
    expect(run.finishedAt).toBe(1_500);
  });

  it('overrides the time budget when asked', async () => {
    const hang: TaskExecutor = () =>
      new Promise<TaskOutcome>(() => {
        /* never settles */
      });
    const run = await runSuite(
      manifest([
        task('patient', { budget: { maxSteps: 10, maxDurationMs: 600_000 } }),
      ]),
      hang,
      { clock: new ManualClock(), timeBudgetMsOverride: 15 },
    );
    expect(run.attempts[0]?.outcome.kind).toBe('timeout');
  });

  it('stops early when the run signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const executor: TaskExecutor = async () => {
      calls += 1;
      controller.abort();
      return { kind: 'success', steps: 1, durationMs: 1 };
    };
    const run = await runSuite(
      manifest([task('a'), task('b'), task('c')]),
      executor,
      { clock: new ManualClock(), signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(run.attempts).toHaveLength(1);
  });

  it('reports progress through onAttempt', async () => {
    const seen: string[] = [];
    await runSuite(manifest([task('a'), task('b')]), succeed, {
      clock: new ManualClock(),
      onAttempt: (a) => seen.push(a.taskId),
    });
    expect(seen).toEqual(['a', 'b']);
  });

  it('carries the manifest hash into the run', async () => {
    const m = manifest([task('a')]);
    const run = await runSuite(m, succeed, { clock: new ManualClock() });
    expect(run.manifestHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run.manifestName).toBe('runner-demo');
  });
});
