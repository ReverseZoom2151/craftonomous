import type { Provenance } from '../observation/provenance.js';
import { PROVENANCE, isFairPlay } from '../observation/provenance.js';

/** A tally of how an agent came by its knowledge over a run. */
export interface PerceptionReport {
  readonly counts: Readonly<Record<Provenance, number>>;
  readonly total: number;
  /** Reads no player could have made. */
  readonly privileged: number;
  /** Privileged reads as a fraction of all reads, 0 when nothing was read. */
  readonly privilegedShare: number;
  /** True when the agent never once read past what a player could sense. */
  readonly fairPlay: boolean;
}

/**
 * Counts observations by provenance for the lifetime of a run.
 *
 * This is the reporting half of the perception contract. The policy decides
 * what may be sensed; the ledger records what actually was, so that a results
 * table can carry the number instead of an assumption.
 */
export class PerceptionLedger {
  readonly #counts: Record<Provenance, number>;

  constructor() {
    this.#counts = Object.fromEntries(PROVENANCE.map((p) => [p, 0])) as Record<
      Provenance,
      number
    >;
  }

  record(provenance: Provenance, times = 1): void {
    if (times < 0) {
      throw new RangeError(`cannot record a negative count: ${times}`);
    }
    this.#counts[provenance] += times;
  }

  report(): PerceptionReport {
    const counts = { ...this.#counts };
    let total = 0;
    for (const p of PROVENANCE) total += counts[p];
    const privileged = counts.privileged;
    return {
      counts,
      total,
      privileged,
      privilegedShare: total === 0 ? 0 : privileged / total,
      fairPlay: PROVENANCE.every((p) => isFairPlay(p) || counts[p] === 0),
    };
  }

  reset(): void {
    for (const p of PROVENANCE) this.#counts[p] = 0;
  }
}
