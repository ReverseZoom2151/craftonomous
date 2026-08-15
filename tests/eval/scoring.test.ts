import { describe, expect, it } from 'vitest';
import {
  OUTCOME_KINDS,
  aggregate,
  isCredited,
  scoreByTask,
  scoreOutcome,
  scoreSuite,
  wilsonLowerBound,
} from '../../src/eval/scoring.js';
import type { OutcomeKind, ScoredOutcome } from '../../src/eval/scoring.js';
import { defineManifest, defineTask } from '../../src/eval/task.js';
import type { Task } from '../../src/eval/task.js';

function task(id: string, impossible: boolean): Task {
  return defineTask('1.0.0', {
    id,
    title: id,
    description: id,
    version: '1.0.0',
    tags: [],
    difficulty: 'easy',
    goal: id,
    budget: { maxSteps: 100, maxDurationMs: 10_000 },
    profile: 'fair-play',
    impossible,
  });
}

const POSSIBLE = task('possible', false);
const IMPOSSIBLE = task('impossible', true);

const outcome = (kind: OutcomeKind) => ({
  kind,
  steps: 5,
  durationMs: 100,
});

describe('wilsonLowerBound', () => {
  it('does not score a perfect small sample as 1.0', () => {
    // The reason this exists: 3/3 is not a 100% agent.
    const three = wilsonLowerBound(3, 3);
    expect(three).toBeLessThan(0.6);
    expect(three).toBeGreaterThan(0.3);
    expect(wilsonLowerBound(1, 1)).toBeLessThan(0.3);
  });

  it('rewards evidence at the same observed rate', () => {
    expect(wilsonLowerBound(50, 50)).toBeGreaterThan(wilsonLowerBound(3, 3));
    expect(wilsonLowerBound(38, 40)).toBeGreaterThan(wilsonLowerBound(1, 1));
  });

  it('never exceeds the observed rate and is zero without evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    for (const [s, n] of [
      [1, 1],
      [3, 3],
      [9, 10],
      [50, 100],
    ] as const) {
      expect(wilsonLowerBound(s, n)).toBeLessThanOrEqual(s / n);
    }
  });

  it('mirrors the skill-layer implementation to three decimals', () => {
    // Deliberate duplication, deliberately pinned: see the comment on the
    // function. Values from docs/SKILL_RELIABILITY.md.
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.21, 2);
    expect(wilsonLowerBound(5, 5)).toBeCloseTo(0.57, 2);
    expect(wilsonLowerBound(50, 50)).toBeCloseTo(0.93, 2);
  });

  it('refuses impossible inputs', () => {
    expect(() => wilsonLowerBound(2, 1)).toThrow(RangeError);
  });
});

describe('scoring an impossible task', () => {
  it('credits a refusal as success', () => {
    const scored = scoreOutcome(IMPOSSIBLE, outcome('refused'));
    expect(scored.credited).toBe(true);
    expect(scored.falseClaim).toBe(false);
  });

  it('treats a reported completion as a false claim, not a success', () => {
    const scored = scoreOutcome(IMPOSSIBLE, outcome('success'));
    expect(scored.credited).toBe(false);
    expect(scored.falseClaim).toBe(true);
  });

  it('credits nothing for failing or timing out', () => {
    for (const kind of ['failure', 'timeout', 'error'] as const) {
      expect(scoreOutcome(IMPOSSIBLE, outcome(kind)).credited).toBe(false);
    }
  });
});

describe('scoring a satisfiable task', () => {
  it('credits only completion', () => {
    for (const kind of OUTCOME_KINDS) {
      expect(isCredited(POSSIBLE, kind)).toBe(kind === 'success');
    }
  });

  it('does not reward refusing something that was achievable', () => {
    expect(scoreOutcome(POSSIBLE, outcome('refused')).credited).toBe(false);
  });
});

describe('aggregate', () => {
  it('is empty and safe with no attempts', () => {
    const a = aggregate([]);
    expect(a.attempts).toBe(0);
    expect(a.confidence).toBe(0);
    expect(a.meanSteps).toBe(0);
  });

  it('ranks on the Wilson bound, not the observed rate', () => {
    const three = aggregate(
      Array.from({ length: 3 }, () =>
        scoreOutcome(POSSIBLE, outcome('success')),
      ),
    );
    expect(three.successRate).toBe(1);
    expect(three.confidence).toBeLessThan(1);
    expect(three.confidence).toBeLessThan(0.6);

    const forty = aggregate(
      Array.from({ length: 40 }, () =>
        scoreOutcome(POSSIBLE, outcome('success')),
      ),
    );
    expect(forty.confidence).toBeGreaterThan(three.confidence);
  });

  it('averages steps and duration', () => {
    const outcomes: ScoredOutcome[] = [
      scoreOutcome(POSSIBLE, { kind: 'success', steps: 10, durationMs: 100 }),
      scoreOutcome(POSSIBLE, { kind: 'failure', steps: 20, durationMs: 300 }),
    ];
    const a = aggregate(outcomes);
    expect(a.meanSteps).toBe(15);
    expect(a.meanDurationMs).toBe(200);
    expect(a.successRate).toBe(0.5);
  });
});

describe('a suite mixing possible and impossible tasks', () => {
  const manifest = defineManifest({
    name: 'mixed',
    version: '1.0.0',
    description: 'mixed',
    tasks: [
      task('p1', false),
      task('p2', false),
      task('i1', true),
      task('i2', true),
    ],
  });

  /** Succeeds at everything it is asked, and never refuses anything. */
  const alwaysAttempt = manifest.tasks.map((t) =>
    scoreOutcome(t, outcome('success')),
  );

  /** Completes what is possible and refuses what is not. */
  const discriminating = manifest.tasks.map((t) =>
    scoreOutcome(t, outcome(t.impossible ? 'refused' : 'success')),
  );

  /** Refuses absolutely everything, to prove refusal is not free. */
  const alwaysRefuse = manifest.tasks.map((t) =>
    scoreOutcome(t, outcome('refused')),
  );

  it('scores an always-attempt agent below a discriminating one', () => {
    const attempt = scoreSuite(alwaysAttempt);
    const discriminate = scoreSuite(discriminating);
    expect(attempt.confidence).toBeLessThan(discriminate.confidence);
    expect(attempt.successRate).toBe(0.5);
    expect(discriminate.successRate).toBe(1);
    expect(attempt.falseClaims).toBe(2);
    expect(discriminate.falseClaims).toBe(0);
  });

  it('scores an always-refuse agent below a discriminating one', () => {
    expect(scoreSuite(alwaysRefuse).confidence).toBeLessThan(
      scoreSuite(discriminating).confidence,
    );
  });

  it('reports discrimination that separates the three strategies', () => {
    expect(scoreSuite(discriminating).discrimination).toBe(1);
    expect(scoreSuite(alwaysAttempt).discrimination).toBe(0);
    expect(scoreSuite(alwaysRefuse).discrimination).toBe(0);
  });

  it('splits the aggregate by satisfiability', () => {
    const s = scoreSuite(alwaysAttempt);
    expect(s.possible.attempts).toBe(2);
    expect(s.possible.credited).toBe(2);
    expect(s.impossible.attempts).toBe(2);
    expect(s.impossible.credited).toBe(0);
  });

  it('reports zero discrimination when nothing is impossible', () => {
    const onlyPossible = scoreSuite([
      scoreOutcome(POSSIBLE, outcome('success')),
    ]);
    expect(onlyPossible.discrimination).toBe(0);
    expect(onlyPossible.impossible.attempts).toBe(0);
  });

  it('rolls attempts up per task in manifest order', () => {
    const rows = scoreByTask(manifest, discriminating);
    expect(rows.map((r) => r.taskId)).toEqual(['p1', 'p2', 'i1', 'i2']);
    expect(rows.every((r) => r.credited === 1)).toBe(true);
  });

  it('omits tasks with no attempts rather than scoring them zero', () => {
    const rows = scoreByTask(manifest, [
      scoreOutcome(manifest.tasks[0] as Task, outcome('success')),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('counts outcomes by kind', () => {
    const s = scoreSuite(discriminating);
    expect(s.byKind.success).toBe(2);
    expect(s.byKind.refused).toBe(2);
    expect(s.byKind.error).toBe(0);
  });
});
