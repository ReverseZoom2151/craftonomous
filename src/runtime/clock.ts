/**
 * Time source. Injected everywhere rather than calling Date.now() directly, so
 * that memory decay, staleness and skill timing are deterministic under test
 * and reproducible when a run is replayed.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  #t: number;

  constructor(start = 0) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError(`cannot advance by ${ms}ms`);
    this.#t += ms;
  }

  set(t: number): void {
    this.#t = t;
  }
}
