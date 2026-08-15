/**
 * The two calls a run actually makes: take everything worth keeping, and put
 * it back.
 */

import type { WorldMemory } from '../perception/memory.js';
import type { ReliabilityTracker } from '../skills/reliability.js';
import type { MemorySnapshotOptions } from './memory-codec.js';
import { restoreWorldMemory, snapshotWorldMemory } from './memory-codec.js';
import { restoreReliability, snapshotReliability } from './reliability-codec.js';
import type { Snapshot } from './snapshot.js';
import { SCHEMA_VERSION } from './snapshot.js';

export interface CaptureOptions extends MemorySnapshotOptions {
  /** Taken from a `Clock`, never from `Date.now()` directly. */
  readonly savedAt: number;
}

export function captureSnapshot(
  memory: WorldMemory,
  tracker: ReliabilityTracker,
  options: CaptureOptions,
): Snapshot {
  const memoryOptions: MemorySnapshotOptions =
    options.maxObservations === undefined
      ? {}
      : { maxObservations: options.maxObservations };
  return {
    version: SCHEMA_VERSION,
    savedAt: options.savedAt,
    memory: snapshotWorldMemory(memory, memoryOptions),
    reliability: snapshotReliability(tracker),
  };
}

export interface RestoreResult {
  /** Observations handed back to memory, each with its original sense time. */
  readonly observations: number;
  /** Skill attempts replayed into the tracker. */
  readonly attempts: number;
}

/**
 * Apply a snapshot to a live memory and tracker. Both are added to rather than
 * cleared first, so a caller that wants a pure restore hands in fresh
 * instances and a caller merging two runs can do that deliberately.
 */
export function applySnapshot(
  memory: WorldMemory,
  tracker: ReliabilityTracker,
  snapshot: Snapshot,
): RestoreResult {
  return {
    observations: restoreWorldMemory(memory, snapshot.memory),
    attempts: restoreReliability(tracker, snapshot.reliability),
  };
}
