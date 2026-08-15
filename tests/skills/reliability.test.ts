import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/runtime/clock.js';
import {
  DEFAULT_MIN_CONTEXT_ATTEMPTS,
  DEFAULT_MIN_EVENTS,
  DEFAULT_RETIREMENT,
  ReliabilityTracker,
  wilsonLowerBound,
} from '../../src/skills/reliability.js';

const ok = { succeeded: true, durationMs: 100 } as const;
const bad = { succeeded: false, durationMs: 300 } as const;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

describe('recency', () => {
  it('does not let last month\'s successes prop up today\'s failures', () => {
    // The scenario the window exists for: a server update broke the skill this
    // morning, and its lifetime record is glowing.
    const clock = new ManualClock(0);
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, { clock });
    for (let i = 0; i < 50; i += 1) t.record('mine', ok);
    expect(t.isRetired('mine')).toBe(false);

    clock.advance(30 * DAY);
    for (let i = 0; i < 10; i += 1) t.record('mine', bad);

    const s = t.stats('mine');
    expect(s.attempts).toBe(10);
    expect(s.successes).toBe(0);
    expect(s.confidence).toBe(0);
    expect(t.isRetired('mine')).toBe(true);
  });

  it('keeps a floor of older evidence when there is little recent evidence', () => {
    const clock = new ManualClock(0);
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, { clock });
    for (let i = 0; i < 50; i += 1) t.record('mine', ok);
    clock.advance(30 * DAY);
    t.record('mine', bad);

    // One fresh failure cannot be judged on its own, so the floor keeps the
    // most recent older attempts for company rather than reporting a rate of
    // zero over a single data point.
    const s = t.stats('mine');
    expect(s.attempts).toBe(DEFAULT_MIN_EVENTS);
    expect(s.successes).toBe(DEFAULT_MIN_EVENTS - 1);
    expect(t.isRetired('mine')).toBe(false);
  });

  it('discards evidence older than the window once newer evidence exists', () => {
    const clock = new ManualClock(0);
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, {
      clock,
      windowMs: 2 * HOUR,
      minEvents: 1,
    });
    for (let i = 0; i < 5; i += 1) t.record('mine', ok);
    clock.advance(3 * HOUR);
    t.record('mine', bad);

    expect(t.stats('mine').attempts).toBe(1);
    expect(t.stats('mine').successes).toBe(0);
  });

  it('still reports what was last learned about a skill nobody has tried lately', () => {
    // The window is anchored on the newest attempt, not on the wall clock:
    // idleness is not evidence of breakage, and reporting nothing would rank a
    // proven skill alongside an untested one.
    const clock = new ManualClock(0);
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, { clock });
    for (let i = 0; i < 20; i += 1) t.record('mine', ok);
    clock.advance(30 * DAY);

    expect(t.stats('mine').attempts).toBe(20);
    expect(t.isRetired('mine')).toBe(false);
  });

  it('bounds memory by discarding the oldest attempts', () => {
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, { maxEvents: 4 });
    for (let i = 0; i < 6; i += 1) t.record('mine', ok);
    expect(t.stats('mine').attempts).toBe(4);
  });
});

describe('per-context conditioning', () => {
  it('separates a place where a skill works from one where it does not', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 10; i += 1) t.record('mine', ok, 'plains');
    for (let i = 0; i < 10; i += 1) t.record('mine', bad, 'ravine');

    expect(t.stats('mine').attempts).toBe(20);
    expect(t.stats('mine').rate).toBe(0.5);
    expect(t.stats('mine', 'plains').rate).toBe(1);
    expect(t.stats('mine', 'ravine').rate).toBe(0);
  });

  it('falls back to the overall record when a context is thin', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 20; i += 1) t.record('mine', ok, 'plains');
    t.record('mine', bad, 'ravine');

    const scoped = t.contextStats('mine', 'ravine');
    expect(scoped.fallback).toBe(true);
    expect(scoped.contextAttempts).toBe(1);
    expect(scoped.attempts).toBe(21);
    expect(scoped.confidence).toBe(t.stats('mine').confidence);
  });

  it('treats a context it has never seen as thin', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 10; i += 1) t.record('mine', ok);

    const scoped = t.contextStats('mine', 'nether');
    expect(scoped.fallback).toBe(true);
    expect(scoped.contextAttempts).toBe(0);
    expect(scoped.attempts).toBe(10);
  });

  it('trusts a context once it has evidence of its own', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 20; i += 1) t.record('mine', ok, 'plains');
    for (let i = 0; i < DEFAULT_MIN_CONTEXT_ATTEMPTS; i += 1) {
      t.record('mine', bad, 'ravine');
    }

    const scoped = t.contextStats('mine', 'ravine');
    expect(scoped.fallback).toBe(false);
    expect(scoped.attempts).toBe(DEFAULT_MIN_CONTEXT_ATTEMPTS);
    expect(scoped.confidence).toBe(0);
  });

  it('honours a custom evidence threshold for conditioning', () => {
    const t = new ReliabilityTracker(DEFAULT_RETIREMENT, {
      minContextAttempts: 2,
    });
    for (let i = 0; i < 20; i += 1) t.record('mine', ok, 'plains');
    t.record('mine', bad, 'ravine');
    t.record('mine', bad, 'ravine');

    expect(t.contextStats('mine', 'ravine').fallback).toBe(false);
    expect(t.stats('mine', 'ravine').rate).toBe(0);
  });

  it('retires a skill where it is broken without retiring it everywhere', () => {
    const t = new ReliabilityTracker();
    for (let i = 0; i < 40; i += 1) t.record('mine', ok, 'plains');
    for (let i = 0; i < 10; i += 1) t.record('mine', bad, 'ravine');

    expect(t.isRetired('mine')).toBe(false);
    expect(t.isRetired('mine', 'plains')).toBe(false);
    expect(t.isRetired('mine', 'ravine')).toBe(true);
  });

  it('lists the contexts it has evidence under', () => {
    const t = new ReliabilityTracker();
    t.record('mine', ok, 'plains');
    t.record('mine', bad, 'ravine');
    t.record('mine', ok);

    expect(t.contexts('mine')).toEqual(['plains', 'ravine']);
    expect(t.contexts('never-run')).toEqual([]);
  });

  it('still accepts a bare two-argument record, as the runner calls it', () => {
    const t = new ReliabilityTracker();
    t.record('mine', ok);
    t.record('mine', bad);
    expect(t.stats('mine').attempts).toBe(2);
    expect(t.contexts('mine')).toEqual([]);
  });
});
