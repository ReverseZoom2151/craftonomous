import type { Provenance } from './provenance.js';
import { isFairPlay } from './provenance.js';

/**
 * A value the agent believes about the world, together with how it came to
 * believe it and when.
 *
 * Nothing in Craftonomous hands an agent a bare value. Bare values are how
 * prior work loses track of what its agents actually knew.
 */
export interface Observed<T> {
  readonly value: T;
  readonly provenance: Provenance;
  /** Wall-clock milliseconds at which this was sensed, from `Clock.now()`. */
  readonly sensedAt: number;
}

/** An observation the agent once had but which may no longer hold. */
export interface Recalled<T> extends Observed<T> {
  readonly provenance: 'memory';
  /** Milliseconds elapsed between sensing and recall. */
  readonly age: number;
}

export function observe<T>(
  value: T,
  provenance: Provenance,
  sensedAt: number,
): Observed<T> {
  return { value, provenance, sensedAt };
}

/** Re-tag a past observation as a recollection, recording how stale it is. */
export function recall<T>(observation: Observed<T>, now: number): Recalled<T> {
  return {
    value: observation.value,
    provenance: 'memory',
    sensedAt: observation.sensedAt,
    age: Math.max(0, now - observation.sensedAt),
  };
}

/** Apply a function to an observed value, preserving its provenance. */
export function mapObserved<T, U>(
  observation: Observed<T>,
  fn: (value: T) => U,
): Observed<U> {
  return {
    value: fn(observation.value),
    provenance: observation.provenance,
    sensedAt: observation.sensedAt,
  };
}

/**
 * Combine several observations into one. The result takes the least
 * trustworthy provenance of its inputs and the oldest sense time, because a
 * conclusion is no fresher and no more direct than its weakest premise.
 */
export function combine<T>(
  parts: readonly Observed<unknown>[],
  value: T,
): Observed<T> {
  if (parts.length === 0) {
    throw new Error('combine() requires at least one source observation');
  }
  let weakest: Provenance = 'proprioception';
  let oldest = Number.POSITIVE_INFINITY;
  for (const part of parts) {
    if (PROVENANCE_TRUST[part.provenance] < PROVENANCE_TRUST[weakest]) {
      weakest = part.provenance;
    }
    oldest = Math.min(oldest, part.sensedAt);
  }
  return { value, provenance: weakest, sensedAt: oldest };
}

/**
 * Ordering used only to pick the weakest premise when combining observations.
 * Higher means more directly grounded in the present moment.
 *
 * `privileged` sits at the bottom despite being perfectly accurate: combining
 * anything with a privileged read yields a privileged result, so the taint
 * propagates and cannot be laundered through a derivation.
 */
const PROVENANCE_TRUST: Record<Provenance, number> = {
  proprioception: 6,
  sight: 5,
  hearing: 4,
  inference: 3,
  testimony: 2,
  memory: 1,
  privileged: 0,
};

/** True when every contributing observation was fairly obtained. */
export function isFairlyObtained(observation: Observed<unknown>): boolean {
  return isFairPlay(observation.provenance);
}
