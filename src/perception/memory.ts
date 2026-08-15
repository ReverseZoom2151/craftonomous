import type { Vec3Like } from '../embodiment/geometry.js';
import { key } from '../embodiment/geometry.js';
import type { BlockInfo } from '../embodiment/types.js';
import type { Observed, Recalled } from '../observation/observed.js';
import { recall as retag } from '../observation/observed.js';
import type { Clock } from '../runtime/clock.js';

/**
 * The part of a {@link PerceptionProfile} that memory cares about: whether a
 * fact sensed at a given moment has fallen past the horizon.
 *
 * Declared structurally rather than as a `PerceptionGate` so that memory has no
 * dependency on the gate, and so a test can hand in a trivial rule.
 */
export interface MemoryExpiry {
  hasExpired(sensedAt: number): boolean;
}

export interface WorldMemoryOptions {
  /**
   * Hard cap on retained blocks. When exceeded, the oldest-sensed entry is
   * evicted first, so a long run cannot grow without limit.
   */
  readonly maxEntries?: number;
  /**
   * Horizon rule applied on read. Without one, memory never fades on its own
   * and callers must sweep with {@link WorldMemory.forgetExpired}.
   */
  readonly expiry?: MemoryExpiry;
}

/**
 * What the agent has seen, and when.
 *
 * Memory is not a world model: it stores observations exactly as they were
 * sensed, and hands them back re-tagged as `memory` with an explicit age. A
 * caller therefore can never mistake a ten-minute-old recollection for a
 * present-tense sighting, which is the failure mode this whole layer exists to
 * prevent.
 */
export class WorldMemory {
  readonly #entries = new Map<string, Observed<BlockInfo>>();
  readonly #clock: Clock;
  readonly #maxEntries: number;
  readonly #expiry: MemoryExpiry | undefined;

  constructor(clock: Clock, options: WorldMemoryOptions = {}) {
    const max = options.maxEntries ?? Number.POSITIVE_INFINITY;
    if (max < 1) {
      throw new RangeError(`maxEntries must be at least 1, got ${max}`);
    }
    this.#clock = clock;
    this.#maxEntries = max;
    this.#expiry = options.expiry;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Record a sighting. A newer observation of a position replaces the older. */
  remember(observation: Observed<BlockInfo>): void {
    this.#entries.set(key(observation.value.position), observation);
    this.#evictOverflow();
  }

  /**
   * What the agent remembers being at a position, re-tagged as a recollection
   * carrying its age. Returns undefined when nothing is remembered there or
   * when the memory has passed the horizon.
   */
  recall(position: Vec3Like): Recalled<BlockInfo> | undefined {
    const entry = this.#entries.get(key(position));
    if (entry === undefined) return undefined;
    if (this.#expired(entry)) return undefined;
    return retag(entry, this.#clock.now());
  }

  /** Whether a live (unexpired) memory exists for a position. */
  has(position: Vec3Like): boolean {
    return this.recall(position) !== undefined;
  }

  /** Drop one position outright. Returns whether anything was there. */
  forget(position: Vec3Like): boolean {
    return this.#entries.delete(key(position));
  }

  /**
   * Drop everything past the horizon. Returns how many entries were evicted,
   * so a caller can log decay rather than guess at it.
   */
  forgetExpired(expiry: MemoryExpiry = this.#expiry ?? NEVER_EXPIRES): number {
    let dropped = 0;
    for (const [k, entry] of this.#entries) {
      if (expiry.hasExpired(entry.sensedAt)) {
        this.#entries.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Every unexpired observation held, in no particular order. */
  all(): readonly Observed<BlockInfo>[] {
    const out: Observed<BlockInfo>[] = [];
    for (const entry of this.#entries.values()) {
      if (!this.#expired(entry)) out.push(entry);
    }
    return out;
  }

  clear(): void {
    this.#entries.clear();
  }

  #expired(entry: Observed<BlockInfo>): boolean {
    return this.#expiry !== undefined && this.#expiry.hasExpired(entry.sensedAt);
  }

  /**
   * Evict oldest-sensed first until the cap holds. Oldest-sensed rather than
   * least-recently-read: the point of the bound is to shed the beliefs least
   * likely to still be true, not the ones least recently asked about.
   */
  #evictOverflow(): void {
    while (this.#entries.size > this.#maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, entry] of this.#entries) {
        if (entry.sensedAt < oldestAt) {
          oldestAt = entry.sensedAt;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) return;
      this.#entries.delete(oldestKey);
    }
  }
}

const NEVER_EXPIRES: MemoryExpiry = { hasExpired: () => false };
