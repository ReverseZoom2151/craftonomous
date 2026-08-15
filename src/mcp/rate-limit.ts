/**
 * Call budgets for the MCP tool surface.
 *
 * The MCP specification requires that a server rate limit tool invocations.
 * This is that enforcement, and it is worth being precise about what it
 * protects, because the answer changes the numbers.
 *
 * It does *not* protect our own CPU. A refused call costs us a map lookup and
 * some arithmetic; if this process were the scarce resource, the limits could
 * be orders of magnitude higher. What is scarce sits downstream:
 *
 *  - **The game server.** Every allowed call turns into packets on a Minecraft
 *    connection. A vanilla or Paper server disconnects a client that floods it,
 *    and an agent in a tight loop looks exactly like a flood. The body is
 *    kicked, the run ends, and nothing in the transcript explains why.
 *  - **The Mojang session and profile endpoints.** These are rate limited by
 *    Mojang, strictly, per account rather than per process, and exceeding them
 *    gets an account temporarily suspended. That penalty outlives the run and
 *    belongs to a person, not to us. It is the reason the defaults here are
 *    conservative rather than merely polite.
 *
 * Two budgets are enforced, and a call needs room in both:
 *
 *  - a **global** budget across every tool, which is the one that actually
 *    bounds traffic to the server, and
 *  - a **per-tool** budget, so that one expensive skill hammered in a loop
 *    cannot drain the global budget and starve every other skill. Without it,
 *    a single misbehaving tool silently becomes a denial of service against
 *    the rest of the body.
 *
 * The algorithm is a token bucket rather than a fixed window. A fixed window
 * lets a client spend its whole allowance in the last instant of one window and
 * again in the first instant of the next, which is a double-rate burst exactly
 * when we least want one. A token bucket admits a bounded burst and then paces
 * everything after it, which is the shape a game connection tolerates.
 *
 * Time comes from an injected {@link Clock}, never `Date.now()`, so a run is
 * deterministic under test and reproducible on replay, the same rule the rest
 * of the codebase follows.
 */
import type { Clock } from '../runtime/clock.js';
import { systemClock } from '../runtime/clock.js';

/**
 * One budget: `limit` calls per `windowMs`.
 *
 * `limit` is both the sustained allowance over a window and the maximum burst,
 * because a full bucket holds exactly one window's worth of tokens. Tokens
 * refill continuously at `limit / windowMs` per millisecond rather than in a
 * lump at the end of the window, so a client that waits a little gets a little.
 */
export interface RateLimitRule {
  /** Calls restored per window, and the largest burst allowed. */
  readonly limit: number;
  /** Length of the window, in milliseconds. */
  readonly windowMs: number;
}

/**
 * The global default: 30 calls per minute across every tool.
 *
 * Chosen against the downstream limits, not ours. Sustained, that is one call
 * every two seconds, which is far below what a Minecraft server treats as
 * abusive and far below anything that would draw Mojang's attention, while
 * still being faster than a body with real skills can usefully act: `move.to`
 * alone budgets 30 seconds. The burst of 30 exists so that an agent opening a
 * run with a flurry of cheap reads is not punished for it.
 */
export const DEFAULT_GLOBAL_RULE: RateLimitRule = {
  limit: 30,
  windowMs: 60_000,
};

/**
 * The per-tool default: 10 calls per minute for any single tool.
 *
 * A third of the global budget. One skill can burst, and can keep going at a
 * steady clip, but cannot on its own exhaust the global bucket and leave the
 * agent unable to do anything else. The asymmetry is the point: it is cheaper
 * to refuse the tool that is looping than to refuse the whole body.
 */
export const DEFAULT_PER_TOOL_RULE: RateLimitRule = {
  limit: 10,
  windowMs: 60_000,
};

/** Which budget refused a call. */
export type RateLimitScope = 'global' | 'tool';

/** Why a call was refused, and when it is worth trying again. */
export interface RateLimitRefusal {
  readonly scope: RateLimitScope;
  /** The tool that was asked for. */
  readonly tool: string;
  /** The rule that ran out. */
  readonly rule: RateLimitRule;
  /** How long until one call is affordable again, in milliseconds. */
  readonly retryAfterMs: number;
  /** The same instant on the injected clock, absolute. */
  readonly retryAtMs: number;
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: RateLimitRefusal };

const ALLOWED: RateLimitDecision = { allowed: true };

export interface RateLimiterOptions {
  /** Budget shared by every tool. Defaults to {@link DEFAULT_GLOBAL_RULE}. */
  readonly global?: RateLimitRule | undefined;
  /** Budget per tool name. Defaults to {@link DEFAULT_PER_TOOL_RULE}. */
  readonly perTool?: RateLimitRule | undefined;
  /** Time source. Defaults to the system clock. */
  readonly clock?: Clock | undefined;
}

function checkRule(rule: RateLimitRule, label: string): RateLimitRule {
  if (!Number.isFinite(rule.limit) || rule.limit <= 0) {
    throw new RangeError(
      `${label} limit must be a positive finite number, got ${rule.limit}`,
    );
  }
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
    throw new RangeError(
      `${label} windowMs must be a positive finite number, got ${rule.windowMs}`,
    );
  }
  return rule;
}

/**
 * A single token bucket.
 *
 * Kept private to this module: callers reason about budgets, not about buckets,
 * and exposing one would invite someone to take a token without asking the
 * other bucket first, which is precisely the bug this file exists to avoid.
 */
class TokenBucket {
  readonly #rule: RateLimitRule;
  /** Tokens per millisecond. */
  readonly #rate: number;
  #tokens: number;
  #updatedAt: number;

  constructor(rule: RateLimitRule, startedAt: number) {
    this.#rule = rule;
    this.#rate = rule.limit / rule.windowMs;
    // Buckets start full. A body that has just connected has not yet spent
    // anything downstream, so there is nothing to make it wait for.
    this.#tokens = rule.limit;
    this.#updatedAt = startedAt;
  }

  #refill(now: number): void {
    // A clock that went backwards (a replay rewinding, a test calling `set`)
    // must not mint tokens. Treat it as no elapsed time and re-anchor.
    if (now <= this.#updatedAt) {
      this.#updatedAt = now;
      return;
    }
    const elapsed = now - this.#updatedAt;
    this.#tokens = Math.min(
      this.#rule.limit,
      this.#tokens + elapsed * this.#rate,
    );
    this.#updatedAt = now;
  }

  /** True when at least one call is affordable right now. */
  affordable(now: number): boolean {
    this.#refill(now);
    return this.#tokens >= 1;
  }

  /**
   * Milliseconds until one call becomes affordable. Zero when it already is.
   *
   * Rounded up: quoting a retry time that is a fraction of a millisecond early
   * would send a well-behaved agent straight into a second refusal.
   */
  retryAfterMs(now: number): number {
    this.#refill(now);
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#rate);
  }

  /** Spend one token. Only call this once the bucket is known affordable. */
  take(now: number): void {
    this.#refill(now);
    this.#tokens -= 1;
  }
}

/**
 * Enforces a global and a per-tool call budget against an injected clock.
 *
 * Not thread safe and does not need to be: a Node MCP server dispatches calls
 * on one event loop, and `check` contains no `await`, so a decision and the
 * spend that follows it cannot be interleaved with another call's.
 */
export class RateLimiter {
  readonly #globalRule: RateLimitRule;
  readonly #perToolRule: RateLimitRule;
  readonly #clock: Clock;
  readonly #global: TokenBucket;
  // Keyed by tool name. Bounded by the registry, which is fixed for a run, so
  // this cannot grow without limit and needs no eviction.
  readonly #perTool = new Map<string, TokenBucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.#globalRule = checkRule(
      options.global ?? DEFAULT_GLOBAL_RULE,
      'global',
    );
    this.#perToolRule = checkRule(
      options.perTool ?? DEFAULT_PER_TOOL_RULE,
      'per-tool',
    );
    this.#clock = options.clock ?? systemClock;
    this.#global = new TokenBucket(this.#globalRule, this.#clock.now());
  }

  /** The budget shared by every tool. */
  get globalRule(): RateLimitRule {
    return this.#globalRule;
  }

  /** The budget applied to each tool separately. */
  get perToolRule(): RateLimitRule {
    return this.#perToolRule;
  }

  #bucketFor(tool: string): TokenBucket {
    const existing = this.#perTool.get(tool);
    if (existing) return existing;
    const created = new TokenBucket(this.#perToolRule, this.#clock.now());
    this.#perTool.set(tool, created);
    return created;
  }

  /**
   * Ask whether one call to `tool` may proceed, spending the budget if so.
   *
   * A call must afford both buckets, and spends from both or from neither. A
   * call allowed by the global budget but refused by its own tool's budget
   * must not quietly consume a global token, or a looping tool would drain the
   * global bucket through refusals alone, which is the starvation the per-tool
   * budget exists to prevent.
   *
   * ## A refused call does not consume budget
   *
   * Deliberate. Two reasons, and the second is the load-bearing one.
   *
   * First, a refusal never reaches the game server or Mojang, so there is
   * nothing downstream to charge it against. Charging for it would throttle
   * the thing we are not protecting.
   *
   * Second, and more important: if refusals consumed budget, every `retryAfter`
   * we quote would be a lie that gets worse each time it is believed. An agent
   * that retries a moment early would push its own deadline further out, and a
   * client polling faster than the refill rate could never recover at all. Not
   * charging keeps `retryAfterMs` monotonically decreasing and honest, which is
   * the whole reason we bother telling the model a number instead of just
   * saying no.
   *
   * The cost of this choice is that a hot-looping client can be refused for
   * free, forever, and we spend a little CPU saying no. That is the resource
   * this limiter is explicitly not protecting.
   */
  check(tool: string): RateLimitDecision {
    const now = this.#clock.now();
    const perTool = this.#bucketFor(tool);

    // Global first: it is the budget that actually bounds traffic downstream,
    // so when both are exhausted it is the more truthful thing to report.
    if (!this.#global.affordable(now)) {
      return this.#refuse('global', tool, this.#globalRule, this.#global, now);
    }
    if (!perTool.affordable(now)) {
      return this.#refuse('tool', tool, this.#perToolRule, perTool, now);
    }

    this.#global.take(now);
    perTool.take(now);
    return ALLOWED;
  }

  #refuse(
    scope: RateLimitScope,
    tool: string,
    rule: RateLimitRule,
    bucket: TokenBucket,
    now: number,
  ): RateLimitDecision {
    const retryAfterMs = bucket.retryAfterMs(now);
    return {
      allowed: false,
      refusal: {
        scope,
        tool,
        rule,
        retryAfterMs,
        retryAtMs: now + retryAfterMs,
      },
    };
  }
}

/**
 * The sentence a refused agent reads.
 *
 * It has one job beyond saying no: name a time. A model told only that it was
 * rate limited retries immediately and makes the situation worse; a model told
 * how long to wait can wait, or can spend the interval planning.
 */
export function describeRefusal(refusal: RateLimitRefusal): string {
  const budget =
    refusal.scope === 'global'
      ? 'the global tool-call budget'
      : `the per-tool budget for "${refusal.tool}"`;
  return (
    `rate limited: ${budget} of ${refusal.rule.limit} calls ` +
    `per ${refusal.rule.windowMs}ms is exhausted. ` +
    `Retry after ${refusal.retryAfterMs}ms, at t=${refusal.retryAtMs}. ` +
    'Waiting is the correct response; retrying sooner will be refused again ' +
    'and the limit exists to stop this body being kicked by the game server ' +
    'or its account throttled by Mojang.'
  );
}

/**
 * How a caller asks for rate limiting, or explicitly asks for none.
 *
 * `'off'` is spelled out rather than being what you get by leaving a field
 * unset, because a limiter that can be disabled by omission is one that gets
 * disabled by accident.
 */
export type RateLimitSetting = RateLimiterOptions | 'off';
