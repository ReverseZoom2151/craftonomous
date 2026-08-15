import type { Vec3Like } from '../embodiment/geometry.js';
import { distance } from '../embodiment/geometry.js';
import type { ChatMessage } from '../embodiment/types.js';

/**
 * What a credibility check was able to establish about a claim.
 *
 * There is no `true` here, and there never will be from this module. Testimony
 * is what somebody said; the strongest thing an agent can honestly conclude
 * without going and looking is that the speaker was in a position to know.
 */
export type TestimonyStatus =
  /** Nothing has been checked. The default, and the only status a raw utterance gets. */
  | 'unverified'
  /** We ourselves saw the speaker close enough to the claim to have sensed it. */
  | 'speaker-could-have-known'
  /** We have seen the speaker, never near the claim. Weak, see the note below. */
  | 'no-sighting-supports-it';

/**
 * A claim somebody made, with who made it and what checking it survived.
 *
 * The provenance of an observation carrying one of these is always `testimony`,
 * whatever the status says. A status is a note about the speaker's opportunity
 * to know, not a promotion: a claim that survives every check here is still
 * hearsay, and turning it into `sight` would be exactly the laundering the
 * provenance tags exist to prevent.
 */
export interface Testimony {
  readonly speaker: string;
  readonly text: string;
  /** True when whispered rather than broadcast. */
  readonly private: boolean;
  readonly status: TestimonyStatus;
  /** Why the status is what it is, in words a run log can carry. */
  readonly reason: string;
}

/** Wrap a raw utterance as what it is: an unverified claim by a named speaker. */
export function unverified(message: ChatMessage): Testimony {
  return {
    speaker: message.from,
    text: message.text,
    private: message.private,
    status: 'unverified',
    reason: 'nothing about this claim has been checked',
  };
}

/** One moment at which the agent saw a speaker somewhere. */
export interface SpeakerSighting {
  readonly position: Vec3Like;
  /** Wall-clock milliseconds, from the observation that produced it. */
  readonly at: number;
}

export interface TestimonyRegisterOptions {
  /**
   * How many sightings to keep per speaker. A register that grew with the
   * session would be the same unbounded buffer problem as the sensor ports
   * have, one layer up.
   */
  readonly maxSightingsPerSpeaker?: number;
  /** How many speakers to track at once, least recently seen evicted first. */
  readonly maxSpeakers?: number;
}

const DEFAULT_MAX_SIGHTINGS = 32;
const DEFAULT_MAX_SPEAKERS = 32;

/**
 * A record of where the agent has seen each speaker, used to ask one modest
 * question: could this speaker plausibly have known what they claim?
 *
 * **What this can establish.** That the agent itself once saw the speaker
 * within sensing range of a claimed position. That is positive evidence of
 * opportunity, and nothing more.
 *
 * **What this cannot establish.** Everything else. It cannot show a claim is
 * true: a player standing on a diamond vein may still lie about it. It cannot
 * show a claim is false either, and deliberately never says so: the agent sees
 * a speaker only at the moments it happens to look, so "no sighting supports
 * it" covers the entirely ordinary case of somebody who walked somewhere while
 * the agent was underground. Treat that status as an absence of evidence and
 * never as evidence of absence. It also knows nothing of relayed claims: a
 * speaker repeating what a third party told them is indistinguishable here
 * from a first-hand report, and neither is worth more than the other in this
 * module.
 *
 * The register is fed only with sightings that already passed the perception
 * gate, so it can never be a side channel around the profile.
 */
export class TestimonyRegister {
  readonly #sightings = new Map<string, SpeakerSighting[]>();
  readonly #maxSightings: number;
  readonly #maxSpeakers: number;

  constructor(options: TestimonyRegisterOptions = {}) {
    this.#maxSightings = Math.max(1, options.maxSightingsPerSpeaker ?? DEFAULT_MAX_SIGHTINGS);
    this.#maxSpeakers = Math.max(1, options.maxSpeakers ?? DEFAULT_MAX_SPEAKERS);
  }

  /** Note that the agent saw this speaker here, at this moment. */
  noteSeen(speaker: string, position: Vec3Like, at: number): void {
    const existing = this.#sightings.get(speaker);
    const trail = existing ?? [];
    trail.push({ position: { ...position }, at });
    while (trail.length > this.#maxSightings) trail.shift();
    // Re-inserting moves the speaker to the end of the map's iteration order,
    // which is what makes the eviction below least-recently-seen.
    this.#sightings.delete(speaker);
    this.#sightings.set(speaker, trail);
    while (this.#sightings.size > this.#maxSpeakers) {
      const oldest = this.#sightings.keys().next();
      if (oldest.done === true) break;
      this.#sightings.delete(oldest.value);
    }
  }

  /** Every sighting of a speaker the register still holds, oldest first. */
  sightingsOf(speaker: string): readonly SpeakerSighting[] {
    return this.#sightings.get(speaker) ?? [];
  }

  /**
   * Check a claim about a position: was the speaker ever seen close enough to
   * it to have sensed it?
   *
   * `sensingRange` should be the range the *speaker* plausibly had, which for
   * another player is their sight range and not the agent's profile.
   */
  checkPositionClaim(
    claim: Testimony,
    position: Vec3Like,
    sensingRange: number,
  ): Testimony {
    const trail = this.#sightings.get(claim.speaker);
    if (trail === undefined || trail.length === 0) {
      return {
        ...claim,
        status: 'unverified',
        reason: `never saw ${claim.speaker}, so nothing can be said either way`,
      };
    }
    const nearest = trail.reduce(
      (best, sighting) => Math.min(best, distance(sighting.position, position)),
      Number.POSITIVE_INFINITY,
    );
    if (nearest <= sensingRange) {
      return {
        ...claim,
        status: 'speaker-could-have-known',
        reason: `saw ${claim.speaker} within ${sensingRange} blocks of the claimed position`,
      };
    }
    return {
      ...claim,
      status: 'no-sighting-supports-it',
      reason:
        `never saw ${claim.speaker} closer than ${nearest.toFixed(1)} blocks to the ` +
        'claimed position, which is not evidence the claim is false',
    };
  }

  /** Forget everything. Used between runs, so one run cannot inform the next. */
  clear(): void {
    this.#sightings.clear();
  }
}
