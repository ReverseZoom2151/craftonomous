import { describe, expect, it } from 'vitest';
import {
  restoreReliability,
  snapshotReliability,
} from '../../src/persistence/reliability-codec.js';
import type { SkillEvidence } from '../../src/persistence/snapshot.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';

function trackerWithHistory(): ReliabilityTracker {
  const tracker = new ReliabilityTracker();
  for (let i = 0; i < 9; i += 1) {
    tracker.record('mine_iron', { succeeded: true, durationMs: 100 });
  }
  tracker.record('mine_iron', { succeeded: false, durationMs: 100 });
  for (let i = 0; i < 10; i += 1) {
    tracker.record('cross_lava', { succeeded: false, durationMs: 40 });
  }
  tracker.record('craft_plank', { succeeded: true, durationMs: 5 });
  return tracker;
}

describe('reliability evidence round trip', () => {
  it('reproduces attempts, successes, rate, confidence and mean duration', () => {
    const before = trackerWithHistory();
    const snapshot = snapshotReliability(before);

    const after = new ReliabilityTracker();
    const replayed = restoreReliability(after, snapshot);

    expect(replayed).toBe(21);
    for (const skill of ['mine_iron', 'cross_lava', 'craft_plank']) {
      const restored = after.stats(skill);
      const original = before.stats(skill);
      expect(restored.attempts).toBe(original.attempts);
      expect(restored.successes).toBe(original.successes);
      expect(restored.rate).toBe(original.rate);
      expect(restored.meanDurationMs).toBe(original.meanDurationMs);
      expect(restored.confidence).toBeCloseTo(original.confidence, 10);
    }
  });

  it('carries a retirement verdict across a restart', () => {
    const before = trackerWithHistory();
    expect(before.retired()).toEqual(['cross_lava']);

    const after = new ReliabilityTracker();
    restoreReliability(after, snapshotReliability(before));

    // The whole point: the evidence that condemned the skill outlives the run
    // that gathered it, so the agent does not cheerfully retry it from zero.
    expect(after.retired()).toEqual(['cross_lava']);
    expect(after.isRetired('mine_iron')).toBe(false);
  });

  it('keeps the ranking order intact', () => {
    const before = trackerWithHistory();
    const after = new ReliabilityTracker();
    restoreReliability(after, snapshotReliability(before));

    expect(after.ranked().map((r) => r.skill)).toEqual(
      before.ranked().map((r) => r.skill),
    );
  });

  it('writes skills in a stable order regardless of when they were recorded', () => {
    const a = new ReliabilityTracker();
    a.record('zeta', { succeeded: true, durationMs: 1 });
    a.record('alpha', { succeeded: true, durationMs: 1 });

    expect(snapshotReliability(a).skills.map((s) => s.skill)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('ignores fields it does not know about', () => {
    const tracker = new ReliabilityTracker();
    // Stand-in for a future tracker that reports more than we persist. The
    // extra field must be inert rather than fatal.
    restoreReliability(tracker, {
      skills: [
        {
          skill: 'mine_iron',
          attempts: 4,
          successes: 3,
          meanDurationMs: 20,
          decayedConfidence: 0.9,
        } as unknown as SkillEvidence,
      ],
    });

    expect(tracker.stats('mine_iron').attempts).toBe(4);
    expect(tracker.stats('mine_iron').successes).toBe(3);
    expect(tracker.stats('mine_iron').meanDurationMs).toBe(20);
  });

  it('captures an untouched tracker as empty', () => {
    expect(snapshotReliability(new ReliabilityTracker()).skills).toEqual([]);
  });
});
