/**
 * World memory to snapshot and back.
 *
 * Both directions go through the public surface of {@link WorldMemory}
 * (`all`, `remember`, `size`) rather than reaching into its map, so a change
 * to how memory stores or expires entries cannot silently change what gets
 * written to disk.
 */

import { key } from '../embodiment/geometry.js';
import type { BlockInfo } from '../embodiment/types.js';
import type { Observed } from '../observation/observed.js';
import { observe } from '../observation/observed.js';
import type { WorldMemory } from '../perception/memory.js';
import type { MemorySnapshot, ObservationRecord } from './snapshot.js';

/**
 * Cap on persisted observations.
 *
 * A snapshot is written on every checkpoint of a run that may last days, so an
 * uncapped file grows until it is slower to load than to rediscover. The
 * number is a compromise: large enough to hold a worked-over base, small
 * enough that the file stays in the low megabytes.
 */
export const DEFAULT_MAX_PERSISTED_OBSERVATIONS = 4096;

export interface MemorySnapshotOptions {
  /** Maximum observations written. Must be at least 1. */
  readonly maxObservations?: number;
}

/**
 * Capture what the agent currently remembers.
 *
 * When more is remembered than the cap allows, the oldest-sensed entries are
 * dropped first. This matches `WorldMemory`'s own eviction policy on purpose:
 * the beliefs least likely to still be true are the ones worth losing, and a
 * persistence layer that shed a different set than memory does would make a
 * restarted agent behave unlike one that simply kept running.
 */
export function snapshotWorldMemory(
  memory: WorldMemory,
  options: MemorySnapshotOptions = {},
): MemorySnapshot {
  const max = options.maxObservations ?? DEFAULT_MAX_PERSISTED_OBSERVATIONS;
  if (max < 1) {
    throw new RangeError(`maxObservations must be at least 1, got ${max}`);
  }

  const sorted = [...memory.all()].sort(bySensedAtThenPosition);
  const kept = sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
  return {
    observations: kept.map((entry) => ({
      block: entry.value,
      provenance: entry.provenance,
      sensedAt: entry.sensedAt,
    })),
  };
}

/**
 * Put a snapshot back into a memory, preserving each observation's original
 * `sensedAt`. Returns how many entries were handed over.
 *
 * Entries are replayed oldest first, so if the target memory has a tighter cap
 * than the snapshot, its own eviction keeps the freshest, exactly as it would
 * have during a live run.
 */
export function restoreWorldMemory(
  memory: WorldMemory,
  snapshot: MemorySnapshot,
): number {
  const entries = [...snapshot.observations].sort(
    (a, b) => a.sensedAt - b.sensedAt,
  );
  for (const entry of entries) {
    memory.remember(toObserved(entry));
  }
  return entries.length;
}

/**
 * Rebuild an observation from its persisted form. The sense time comes from
 * the record, never from a clock.
 */
export function toObserved(record: ObservationRecord): Observed<BlockInfo> {
  return observe(record.block, record.provenance, record.sensedAt);
}

/**
 * Oldest first, with position as a tie-break so that two runs that saw the
 * same world produce byte-identical snapshots.
 */
function bySensedAtThenPosition(
  a: Observed<BlockInfo>,
  b: Observed<BlockInfo>,
): number {
  if (a.sensedAt !== b.sensedAt) return a.sensedAt - b.sensedAt;
  return key(a.value.position).localeCompare(key(b.value.position));
}
