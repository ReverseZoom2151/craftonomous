import type { Observed } from '../observation/observed.js';
import { observe } from '../observation/observed.js';
import type { Provenance } from '../observation/provenance.js';
import type { Clock } from '../runtime/clock.js';
import { PerceptionLedger } from './ledger.js';
import type { PerceptionProfile } from './profile.js';

/** Raised when an agent attempts a read its profile forbids. */
export class PerceptionDenied extends Error {
  constructor(
    readonly provenance: Provenance,
    readonly profile: string,
    detail: string,
  ) {
    super(`perception denied under profile "${profile}": ${detail}`);
    this.name = 'PerceptionDenied';
  }
}

export interface SightCheck {
  /** Distance from the agent's eyes, in blocks. */
  readonly distance: number;
  /** Whether something solid stands between the agent's eyes and the target. */
  readonly occluded: boolean;
}

/**
 * Enforces a {@link PerceptionProfile} and tallies every read into a
 * {@link PerceptionLedger}.
 *
 * Every observation an agent receives passes through here. Skills never read
 * the underlying game client directly; that is what keeps the ledger honest.
 */
export class PerceptionGate {
  readonly ledger: PerceptionLedger;

  constructor(
    readonly profile: PerceptionProfile,
    private readonly clock: Clock,
    ledger?: PerceptionLedger,
  ) {
    this.ledger = ledger ?? new PerceptionLedger();
  }

  /** Whether a target at this distance and occlusion is currently visible. */
  canSee({ distance, occluded }: SightCheck): boolean {
    if (distance > this.profile.sightRange) return false;
    if (occluded && this.profile.requireLineOfSight) return false;
    return true;
  }

  /** Whether a sound at this distance registers. */
  canHear(distance: number): boolean {
    return distance <= this.profile.hearingRange;
  }

  /** Whether a fact sensed at this time has fallen out of memory. */
  hasExpired(sensedAt: number): boolean {
    const horizon = this.profile.memoryHorizonMs;
    if (horizon === Number.POSITIVE_INFINITY) return false;
    return this.clock.now() - sensedAt > horizon;
  }

  /**
   * Admit a value as an observation, recording its provenance.
   *
   * Throws {@link PerceptionDenied} for a privileged read under a profile that
   * forbids one. Failing loudly is deliberate: a silently dropped privileged
   * read would leave the agent quietly less capable and the reason buried.
   */
  sense<T>(value: T, provenance: Provenance): Observed<T> {
    if (provenance === 'privileged' && !this.profile.allowPrivileged) {
      throw new PerceptionDenied(
        provenance,
        this.profile.name,
        'this profile permits only what a player could sense unaided',
      );
    }
    this.ledger.record(provenance);
    return observe(value, provenance, this.clock.now());
  }

  /**
   * Admit a sighting, subject to range and occlusion. Returns undefined when
   * the target cannot currently be seen, which callers should treat as "not
   * known" rather than "not there".
   */
  sight<T>(value: T, check: SightCheck): Observed<T> | undefined {
    if (!this.canSee(check)) return undefined;
    return this.sense(value, 'sight');
  }

  /** Admit a sound, subject to hearing range. */
  sound<T>(value: T, distance: number): Observed<T> | undefined {
    if (!this.canHear(distance)) return undefined;
    return this.sense(value, 'hearing');
  }
}
