/**
 * Skill track records to snapshot and back.
 *
 * The tracker's evidence is deliberately read through `ranked()` and written
 * back through `record()`, the two public members whose meaning is fixed by
 * the reliability contract. Nothing here knows the tracker's internal record
 * shape, so extra fields it grows later cost this module nothing: they are
 * simply not persisted, and a restored tracker recomputes whatever it derives.
 */

import type { ReliabilityTracker } from '../skills/reliability.js';
import type { ReliabilitySnapshot, SkillEvidence } from './snapshot.js';

/**
 * Capture every skill's track record.
 *
 * Only the raw counts and the mean duration are kept. Derived quantities such
 * as the Wilson lower bound are not persisted, because persisting a derived
 * number invites a future build to disagree with its own stored conclusion.
 */
export function snapshotReliability(
  tracker: ReliabilityTracker,
): ReliabilitySnapshot {
  const skills: SkillEvidence[] = [];
  for (const entry of tracker.ranked()) {
    skills.push({
      skill: entry.skill,
      attempts: entry.attempts,
      successes: entry.successes,
      meanDurationMs: entry.meanDurationMs,
    });
  }
  skills.sort((a, b) => a.skill.localeCompare(b.skill));
  return { skills };
}

/**
 * Replay stored evidence into a tracker.
 *
 * Attempts are replayed as individual outcomes because `record()` is the only
 * public way in. Each replayed attempt carries the stored mean duration, so
 * the restored mean equals the saved mean exactly, while attempts, successes
 * and therefore the confidence bound are reproduced without loss.
 *
 * What replay cannot reproduce is the original ordering or spacing of the
 * attempts, since neither is exposed. A tracker that weights recent evidence
 * more heavily will treat restored evidence as having arrived at restore time.
 * That is a known and bounded loss, and it errs towards trusting old evidence
 * slightly too much rather than inventing evidence that never existed.
 */
export function restoreReliability(
  tracker: ReliabilityTracker,
  snapshot: ReliabilitySnapshot,
): number {
  let replayed = 0;
  for (const evidence of snapshot.skills) {
    const successes = Math.min(evidence.successes, evidence.attempts);
    const failures = evidence.attempts - successes;
    for (let i = 0; i < successes; i += 1) {
      tracker.record(evidence.skill, {
        succeeded: true,
        durationMs: evidence.meanDurationMs,
      });
    }
    for (let i = 0; i < failures; i += 1) {
      tracker.record(evidence.skill, {
        succeeded: false,
        durationMs: evidence.meanDurationMs,
      });
    }
    replayed += evidence.attempts;
  }
  return replayed;
}
