import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETIREMENT,
  ReliabilityTracker,
  wilsonLowerBound,
} from '../../src/skills/reliability.js';

const ok = { succeeded: true, durationMs: 100 } as const;
const bad = { succeeded: false, durationMs: 300 } as const;

describe('wilsonLowerBound', () => {
  it('is zero with no evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('refuses impossible inputs', () => {
    expect(() => wilsonLowerBound(2, 1)).toThrow(RangeError);
    expect(() => wilsonLowerBound(-1, 5)).toThrow(RangeError);
  });

  it('does not flatter a single success', () => {
    // The whole reason for using Wilson rather than the naive rate.
    expect(wilsonLowerBound(1, 1)).toBeLessThan(0.3);
    expect(wilsonLowerBound(1, 1)).toBeGreaterThan(0.15);
  });

  it('rises as evidence accumulates at the same rate', () => {
    expect(wilsonLowerBound(50, 50)).toBeGreaterThan(wilsonLowerBound(5, 5));
    expect(wilsonLowerBound(500, 500)).toBeGreaterThan(
      wilsonLowerBound(50, 50),
    );
  });

  it('never exceeds the observed rate', () => {
    for (const [s, n] of [
      [1, 1],
      [3, 4],
      [9, 10],
      [50, 100],
    ] as const) {
      expect(wilsonLowerBound(s, n)).toBeLessThanOrEqual(s / n);
    }
  });

  it('is zero when nothing ever worked', () => {
    expect(wilsonLowerBound(0, 20)).toBe(0);
  });

  it('stays within the unit interval', () => {
    for (const [s, n] of [
      [0, 1],
      [1, 2],
      [999, 1000],
    ] as const) {
      const v = wilsonLowerBound(s, n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('ReliabilityTracker', () => {
  it('reports empty stats for an unknown skill', () => {
    const t = new ReliabilityTracker();
    expect(t.stats('never-run')).toEqual({
      attempts: 0,
      successes: 0,
      rate: 0,
      confidence: 0,
      meanDurationMs: 0,
    });
  });

  it('counts attempts, successes and mean duration', () => {
    const t = new ReliabilityTracker();
    t.record('mine', ok);
    t.record('mine', bad);
    const s = t.stats('mine');
    expect(s.attempts).toBe(2);
    expect(s.successes).toBe(1);
    expect(s.rate).toBe(0.5);
    expect(s.meanDurationMs).toBe(200);
  });

  it('reports confidence below the raw rate', () => {
    const t = new ReliabilityTracker();
    t.record('mine', ok);
    const s = t.stats('mine');
    expect(s.rate).toBe(1);
    expect(s.confidence).toBeLessThan(1);
  });
});

describe('retirement', () => {
  it('never retires an untried skill', () => {
    const t = new ReliabilityTracker();
    expect(t.isRetired('unknown')).toBe(false);
  });

  it('does not retire before there is enough evidence', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < DEFAULT_RETIREMENT.minAttempts - 1; i++) {
      t.record('flaky', bad);
    }
    expect(t.isRetired('flaky')).toBe(false);
  });

  it('retires a skill that consistently fails once evidence suffices', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < DEFAULT_RETIREMENT.minAttempts; i++) {
      t.record('broken', bad);
    }
    expect(t.isRetired('broken')).toBe(true);
    expect(t.retired()).toContain('broken');
  });

  it('keeps a skill that works', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 20; i++) t.record('solid', ok);
    expect(t.isRetired('solid')).toBe(false);
  });

  it('honours a custom policy', () => {
    const strict = new ReliabilityTracker({
      minAttempts: 2,
      minConfidence: 0.99,
    });
    strict.record('good-enough', ok);
    strict.record('good-enough', ok);
    expect(strict.isRetired('good-enough')).toBe(true);
  });
});

describe('ranking', () => {
  it('orders by confidence, not by raw rate', () => {
    const t = new ReliabilityTracker();
    // Lucky: one attempt, one success. Raw rate 1.0.
    t.record('lucky', ok);
    // Proven: forty attempts, thirty-eight successes. Raw rate 0.95.
    for (let i = 0; i < 38; i++) t.record('proven', ok);
    for (let i = 0; i < 2; i++) t.record('proven', bad);

    expect(t.stats('lucky').rate).toBeGreaterThan(t.stats('proven').rate);
    expect(t.ranked()[0]?.skill).toBe('proven');
  });

  it('lists only skills that have been tried', () => {
    const t = new ReliabilityTracker();
    t.record('tried', ok);
    expect(t.ranked().map((r) => r.skill)).toEqual(['tried']);
  });

  it('clears on reset', () => {
    const t = new ReliabilityTracker();
    t.record('mine', ok);
    t.reset();
    expect(t.ranked()).toHaveLength(0);
  });
});
