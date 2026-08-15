/**
 * Tracks whether skills actually work.
 *
 * Prior skill libraries publish a count of skills. A count says nothing about
 * whether any of them still work against the current server, the current
 * Minecraft version, or the situation the agent is in right now. A library
 * that cannot answer "which of my skills are reliable" is a list, not a
 * library, so reliability is recorded here as a first-class property.
 */

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

interface Record_ {
  attempts: number;
  successes: number;
  totalDurationMs: number;
}

export class ReliabilityTracker {
  readonly #records = new Map<string, Record_>();

  constructor(private readonly policy: RetirementPolicy = DEFAULT_RETIREMENT) {}

  record(skill: string, outcome: SkillOutcome): void {
    const r = this.#records.get(skill) ?? {
      attempts: 0,
      successes: 0,
      totalDurationMs: 0,
    };
    r.attempts += 1;
    if (outcome.succeeded) r.successes += 1;
    r.totalDurationMs += outcome.durationMs;
    this.#records.set(skill, r);
  }

  stats(skill: string): ReliabilityStats {
    const r = this.#records.get(skill);
    if (!r || r.attempts === 0) {
      return {
        attempts: 0,
        successes: 0,
        rate: 0,
        confidence: 0,
        meanDurationMs: 0,
      };
    }
    return {
      attempts: r.attempts,
      successes: r.successes,
      rate: r.successes / r.attempts,
      confidence: wilsonLowerBound(r.successes, r.attempts),
      meanDurationMs: r.totalDurationMs / r.attempts,
    };
  }

  /**
   * Whether a skill has earned retirement: enough evidence to judge it, and a
   * confidence bound that fails the policy. An untried skill is never retired,
   * because absence of evidence is not evidence of failure.
   */
  isRetired(skill: string): boolean {
    const s = this.stats(skill);
    if (s.attempts < this.policy.minAttempts) return false;
    return s.confidence < this.policy.minConfidence;
  }

  /** Every skill that has been tried, ranked most to least reliable. */
  ranked(): readonly (ReliabilityStats & { skill: string })[] {
    return [...this.#records.keys()]
      .map((skill) => ({ skill, ...this.stats(skill) }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  retired(): readonly string[] {
    return [...this.#records.keys()].filter((s) => this.isRetired(s));
  }

  reset(): void {
    this.#records.clear();
  }
}
