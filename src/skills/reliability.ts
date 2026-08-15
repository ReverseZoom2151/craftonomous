/**
 * Tracks whether skills actually work.
 *
 * Prior skill libraries publish a count of skills. A count says nothing about
 * whether any of them still work against the current server, the current
 * Minecraft version, or the situation the agent is in right now. A library
 * that cannot answer "which of my skills are reliable" is a list, not a
 * library, so reliability is recorded here as a first-class property.
 *
 * Two things make that record honest rather than decorative.
 *
 * *Recency*. Evidence has an age. A skill broken by yesterday's server update
 * does not deserve to be propped up by last month's successes, so old attempts
 * stop counting once newer ones exist to replace them.
 *
 * *Situation*. A skill can be reliable in plains and hopeless in a ravine, and
 * a single average over both is a number that describes neither. Attempts may
 * therefore be filed under a context key, and asked about the same way.
 */

import type { Clock } from '../runtime/clock.js';
import { systemClock } from '../runtime/clock.js';

/** Two-sided z for a 95% confidence interval. */
const Z = 1.959963984540054;

export interface SkillOutcome {
  readonly succeeded: boolean;
  /** Wall-clock milliseconds the attempt took. */
  readonly durationMs: number;
}

export interface ReliabilityStats {
  readonly attempts: number;
  readonly successes: number;
  /**
   * Observed success rate. Do not rank on this: one success out of one attempt
   * scores 1.0 and means nothing.
   */
  readonly rate: number;
  /**
   * Wilson score lower bound at 95% confidence. This is the number to rank and
   * to gate on, because it penalises small samples instead of flattering them.
   * A single success yields roughly 0.21, not 1.0.
   */
  readonly confidence: number;
  /** Mean duration of attempts, in milliseconds. */
  readonly meanDurationMs: number;
}

/** Stats for one situation, plus whether the answer actually came from it. */
export interface ContextualStats extends ReliabilityStats {
  /** The context that was asked about. */
  readonly context: string;
  /**
   * True when this context had too little evidence of its own and the overall
   * record was returned instead.
   */
  readonly fallback: boolean;
  /** Attempts this context contributed inside the window, before fallback. */
  readonly contextAttempts: number;
}

export interface RetirementPolicy {
  /** Attempts required before a skill may be retired at all. */
  readonly minAttempts: number;
  /** Retire when the confidence lower bound falls below this. */
  readonly minConfidence: number;
}

export const DEFAULT_RETIREMENT: RetirementPolicy = {
  minAttempts: 8,
  minConfidence: 0.25,
};

/** Evidence older than this, relative to the newest attempt, stops counting. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Attempts always kept regardless of age.
 *
 * Without this floor a skill tried once a day would never accumulate enough
 * in-window evidence to be judged at all, and the tracker would be blind to
 * exactly the sparsely used skills it most needs an opinion about.
 */
export const DEFAULT_MIN_EVENTS = 8;

/** Attempts a context needs of its own before its stats are trusted. */
export const DEFAULT_MIN_CONTEXT_ATTEMPTS = 5;

/** Attempts retained per skill. The oldest are discarded first. */
export const DEFAULT_MAX_EVENTS = 512;

export interface ReliabilityOptions {
  /** Injected so that windowing is deterministic under test. */
  readonly clock?: Clock;
  readonly windowMs?: number;
  readonly minEvents?: number;
  readonly minContextAttempts?: number;
  readonly maxEvents?: number;
}

/**
 * Wilson score interval, lower bound.
 *
 * Preferred over the naive rate because the naive rate is maximally wrong
 * exactly when we have least evidence, which is when a skill has just been
 * written and is most likely to be broken.
 */
export function wilsonLowerBound(successes: number, attempts: number): number {
  if (attempts <= 0) return 0;
  if (successes < 0 || successes > attempts) {
    throw new RangeError(
      `successes (${successes}) must lie within 0..${attempts}`,
    );
  }
  const n = attempts;
  const p = successes / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

/** One recorded attempt. */
interface Attempt {
  readonly at: number;
  readonly succeeded: boolean;
  readonly durationMs: number;
  readonly context: string | undefined;
}

const EMPTY_STATS: ReliabilityStats = {
  attempts: 0,
  successes: 0,
  rate: 0,
  confidence: 0,
  meanDurationMs: 0,
};

function summarise(attempts: readonly Attempt[]): ReliabilityStats {
  if (attempts.length === 0) return EMPTY_STATS;
  let successes = 0;
  let totalDurationMs = 0;
  for (const a of attempts) {
    if (a.succeeded) successes += 1;
    totalDurationMs += a.durationMs;
  }
  const n = attempts.length;
  return {
    attempts: n,
    successes,
    rate: successes / n,
    confidence: wilsonLowerBound(successes, n),
    meanDurationMs: totalDurationMs / n,
  };
}

export class ReliabilityTracker {
  readonly #attempts = new Map<string, Attempt[]>();
  readonly #clock: Clock;
  readonly #windowMs: number;
  readonly #minEvents: number;
  readonly #minContextAttempts: number;
  readonly #maxEvents: number;

  /**
   * The policy stays the first positional argument so that every existing
   * construction keeps working unchanged.
   */
  constructor(
    private readonly policy: RetirementPolicy = DEFAULT_RETIREMENT,
    options: ReliabilityOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#minEvents = options.minEvents ?? DEFAULT_MIN_EVENTS;
    this.#minContextAttempts =
      options.minContextAttempts ?? DEFAULT_MIN_CONTEXT_ATTEMPTS;
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /**
   * File an attempt.
   *
   * `context` is whatever the caller can say about the situation: a biome, a
   * dimension, a server name. The tracker attaches no meaning to it beyond
   * equality, which is the only way it can stay useful to callers who know
   * things about their world that this module does not.
   */
  record(skill: string, outcome: SkillOutcome, context?: string): void {
    const log = this.#attempts.get(skill) ?? [];
    log.push({
      at: this.#clock.now(),
      succeeded: outcome.succeeded,
      durationMs: outcome.durationMs,
      context,
    });
    // Bound the memory. Dropping from the front discards the oldest evidence,
    // which is the evidence the window would have discounted anyway.
    if (log.length > this.#maxEvents)
      log.splice(0, log.length - this.#maxEvents);
    this.#attempts.set(skill, log);
  }

  /**
   * The attempts that still count, newest last.
   *
   * An attempt survives if it is inside the window measured back from the
   * newest attempt, or if it is one of the last `minEvents`. Anchoring on the
   * newest attempt rather than on the current time matters: a skill nobody has
   * tried for a week should report what was last learned about it, not report
   * nothing at all, and "nothing" would rank it alongside a skill that is
   * actively failing.
   */
  #window(attempts: readonly Attempt[]): readonly Attempt[] {
    if (attempts.length === 0) return attempts;
    const newest = attempts[attempts.length - 1];
    if (!newest) return attempts;
    let first = attempts.length;
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const a = attempts[i];
      if (!a) break;
      const kept = attempts.length - i;
      if (kept > this.#minEvents && newest.at - a.at > this.#windowMs) break;
      first = i;
    }
    return attempts.slice(first);
  }

  #recent(skill: string, context?: string): readonly Attempt[] {
    const all = this.#attempts.get(skill) ?? [];
    if (context === undefined) return this.#window(all);
    return this.#window(all.filter((a) => a.context === context));
  }

  /**
   * Stats for a skill, optionally conditioned on a situation.
   *
   * With a context that has little evidence of its own, this answers with the
   * overall record rather than with a confident-looking number derived from
   * two attempts in a ravine. Use `contextStats` when it matters whether the
   * answer was conditioned or fell back.
   */
  stats(skill: string, context?: string): ReliabilityStats {
    if (context === undefined) return summarise(this.#recent(skill));
    return this.contextStats(skill, context);
  }

  /** As `stats`, and says whether the context or the overall record answered. */
  contextStats(skill: string, context: string): ContextualStats {
    const scoped = this.#recent(skill, context);
    if (scoped.length >= this.#minContextAttempts) {
      return {
        ...summarise(scoped),
        context,
        fallback: false,
        contextAttempts: scoped.length,
      };
    }
    return {
      ...summarise(this.#recent(skill)),
      context,
      fallback: true,
      contextAttempts: scoped.length,
    };
  }

  /** Contexts this skill has evidence under, in first-seen order. */
  contexts(skill: string): readonly string[] {
    const seen = new Set<string>();
    for (const a of this.#attempts.get(skill) ?? []) {
      if (a.context !== undefined) seen.add(a.context);
    }
    return [...seen];
  }

  /**
   * Whether a skill has earned retirement: enough evidence to judge it, and a
   * confidence bound that fails the policy. An untried skill is never retired,
   * because absence of evidence is not evidence of failure.
   *
   * Because the evidence is windowed, a skill that broke this morning can be
   * retired on this morning's attempts even though its lifetime record is
   * excellent. That is the point: the lifetime record describes a server that
   * no longer exists.
   */
  isRetired(skill: string, context?: string): boolean {
    const s = this.stats(skill, context);
    if (s.attempts < this.policy.minAttempts) return false;
    return s.confidence < this.policy.minConfidence;
  }

  /** Every skill that has been tried, ranked most to least reliable. */
  ranked(): readonly (ReliabilityStats & { skill: string })[] {
    return [...this.#attempts.keys()]
      .map((skill) => ({ skill, ...this.stats(skill) }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  retired(): readonly string[] {
    return [...this.#attempts.keys()].filter((s) => this.isRetired(s));
  }

  reset(): void {
    this.#attempts.clear();
  }
}
