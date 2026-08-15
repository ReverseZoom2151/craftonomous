import type { Logger } from '../../runtime/logger.js';
import { silentLogger } from '../../runtime/logger.js';
import type { MineflayerBotLike, ReconnectPolicy } from './binding.js';
import { DEFAULT_RECONNECT, MAX_JOIN_ATTEMPTS, backoffDelay } from './binding.js';

/**
 * Death, respawn and reconnection: everything that happens to a session after
 * it is up.
 *
 * `connect()` in `binding.ts` retries only the first join. Once a session is
 * established a kick, a dropped socket or a death leaves the body in a state
 * nothing else in the codebase is watching for, and the first live run meets at
 * least one of them within minutes. This file watches for them, and is written
 * so the parts that matter can be checked without a server: the join budget and
 * the death state machine are ordinary objects with an injected clock.
 *
 * What this file deliberately does not do is repair anything above the gate.
 * See {@link SessionSupervisor} on why a reconnect makes the perception layer's
 * memory wrong, and why fixing that is somebody else's call to make.
 */

/** The window Mojang's join rate limit is measured over. */
export const JOIN_WINDOW_MS = 30_000;

/**
 * A shared budget of session joins, honouring Mojang's limit of six joins per
 * thirty seconds per account.
 *
 * Initial joins and reconnects draw on the *same* budget, because the server
 * counts them the same way. A reconnect loop is the dangerous one: it can fire
 * again and again across a long session, and the documented penalty for a high
 * volume of errors is an account suspension that typically clears only after a
 * day. The cap here is {@link MAX_JOIN_ATTEMPTS}, one under Mojang's six, for
 * the same reason it is there: leave a join of headroom for whatever else is
 * using the account.
 */
export class JoinBudget {
  readonly #joins: number[] = [];

  constructor(
    readonly maxJoins: number = MAX_JOIN_ATTEMPTS,
    readonly windowMs: number = JOIN_WINDOW_MS,
  ) {}

  /** Note that a join was attempted at this time. Attempts count, not successes. */
  record(at: number): void {
    this.#joins.push(at);
    this.#evict(at);
  }

  /** Joins still inside the window at this time. */
  used(at: number): number {
    this.#evict(at);
    return this.#joins.length;
  }

  /** How long to wait before another join is within the limit. */
  waitFor(at: number): number {
    this.#evict(at);
    if (this.#joins.length < this.maxJoins) return 0;
    const oldest = this.#joins[0];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + this.windowMs - at);
  }

  #evict(at: number): void {
    while (this.#joins.length > 0) {
      const oldest = this.#joins[0];
      if (oldest === undefined || oldest > at - this.windowMs) break;
      this.#joins.shift();
    }
  }
}

/** Where the body is in the live-or-dead cycle. */
export type BodyStatus = 'alive' | 'dead' | 'respawning';

/** Something that happened to the session, worth telling a run about. */
export type LifecycleEvent =
  /**
   * The body died. Usually the end of a benchmark attempt: everything carried
   * is on the ground somewhere and the body is about to be somewhere else.
   */
  | { readonly kind: 'death'; readonly at: number; readonly deaths: number }
  /** A respawn was asked for. Never implicit unless the caller chose `auto`. */
  | { readonly kind: 'respawn-requested'; readonly at: number }
  /** The body is alive again, at the spawn point, carrying nothing it dropped. */
  | { readonly kind: 'respawned'; readonly at: number }
  /** The session ended. `intentional` separates a `close()` from a kick. */
  | {
      readonly kind: 'disconnected';
      readonly at: number;
      readonly reason: string;
      readonly intentional: boolean;
    }
  | {
      readonly kind: 'reconnecting';
      readonly at: number;
      readonly attempt: number;
      readonly delayMs: number;
    }
  /**
   * A new session is up. `generation` counts sessions from 1, and everything
   * learned in an earlier generation is now suspect: see
   * {@link SessionSupervisor}.
   */
  | { readonly kind: 'reconnected'; readonly at: number; readonly generation: number }
  | { readonly kind: 'reconnect-failed'; readonly at: number; readonly reason: string };

export type LifecycleListener = (event: LifecycleEvent) => void;

/** The outcome of asking for a respawn. */
export interface RespawnOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SessionSupervisorOptions {
  /** The live bot to watch. Replaced on every successful reconnect. */
  readonly bot: MineflayerBotLike;
  /**
   * How to obtain a fresh bot. Supplied by whoever wired the body, because this
   * file has no business knowing the credentials.
   */
  readonly rejoin?: () => Promise<MineflayerBotLike>;
  /**
   * `manual` (the default) reports a death and waits. `auto` still reports the
   * death first, then asks for the respawn itself. There is no mode that
   * respawns without saying so: a death costs the whole inventory and the whole
   * position, and a scorer that never hears about it will read the loss as a
   * planner that suddenly got worse.
   */
  readonly respawn?: 'manual' | 'auto';
  readonly policy?: Partial<ReconnectPolicy>;
  /** Shared with any other session on the same account, when there is one. */
  readonly budget?: JoinBudget;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Watches one session: death, respawn, and reconnection after an unexpected
 * drop.
 *
 * **Reconnecting invalidates knowledge, and this class cannot fix that.** Entity
 * ids are reassigned by the server and every id the agent holds now points at
 * nothing or at somebody else; the world has moved on while the socket was
 * down; and anything remembered is older than its timestamp claims, because the
 * memory horizon was measured against a session that no longer exists. This
 * file sits below the perception gate and has no business reaching up into
 * `WorldMemory`. It emits `reconnected` with a generation number instead, and
 * the wiring layer is expected to act on it.
 */
export class SessionSupervisor {
  #bot: MineflayerBotLike;
  #status: BodyStatus = 'alive';
  #deaths = 0;
  #generation = 1;
  #closed = false;
  #reconnecting = false;
  readonly #listeners = new Set<LifecycleListener>();
  readonly #policy: ReconnectPolicy;
  readonly #budget: JoinBudget;
  readonly #rejoin: (() => Promise<MineflayerBotLike>) | undefined;
  readonly #respawnMode: 'manual' | 'auto';
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Logger;

  constructor(options: SessionSupervisorOptions) {
    this.#bot = options.bot;
    this.#rejoin = options.rejoin;
    this.#respawnMode = options.respawn ?? 'manual';
    this.#budget = options.budget ?? new JoinBudget();
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.#log = options.logger ?? silentLogger;

    const requested: ReconnectPolicy = { ...DEFAULT_RECONNECT, ...options.policy };
    this.#policy = {
      ...requested,
      maxAttempts: Math.min(MAX_JOIN_ATTEMPTS, Math.max(1, requested.maxAttempts)),
    };

    this.#watch(this.#bot);
  }

  /** The bot currently being supervised. Changes on reconnect. */
  get bot(): MineflayerBotLike {
    return this.#bot;
  }

  get status(): BodyStatus {
    return this.#status;
  }

  get deaths(): number {
    return this.#deaths;
  }

  /** Sessions so far, counting from 1. Anything learned in an earlier one is stale. */
  get generation(): number {
    return this.#generation;
  }

  /** True once {@link close} has been called. A closed session never reconnects. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Subscribe. Returns a function that unsubscribes. */
  on(listener: LifecycleListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Ask the server to respawn the body.
   *
   * Refused unless the body is actually dead, so a caller cannot use this as a
   * teleport. Refused too when the substrate offers no respawn call, which is
   * reported rather than swallowed: a bot that quietly never respawns looks
   * exactly like a planner that stopped having ideas.
   */
  requestRespawn(): RespawnOutcome {
    if (this.#closed) return { ok: false, detail: 'session is closed' };
    if (this.#status !== 'dead') {
      return { ok: false, detail: `body is ${this.#status}, not dead` };
    }
    const respawn = this.#bot.respawn;
    if (respawn === undefined) {
      return { ok: false, detail: 'this substrate cannot respawn on request' };
    }
    try {
      respawn.call(this.#bot);
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
    this.#status = 'respawning';
    this.#emit({ kind: 'respawn-requested', at: this.#now() });
    return { ok: true };
  }

  /**
   * Intentional shutdown. This is the only way to end a session without the
   * supervisor trying to bring it back, and it is one-way.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit({
      kind: 'disconnected',
      at: this.#now(),
      reason: 'closed by caller',
      intentional: true,
    });
  }

  /**
   * Note that somebody is about to disconnect on purpose, without emitting a
   * second disconnect event. Wire this to whatever calls `EmbodimentPort.disconnect`
   * so an intentional teardown is never mistaken for a drop.
   */
  noteIntentionalDisconnect(): void {
    this.#closed = true;
  }

  #watch(bot: MineflayerBotLike): void {
    bot.on('death', () => {
      this.#deaths += 1;
      this.#status = 'dead';
      const at = this.#now();
      this.#log.warn('body died', { deaths: this.#deaths });
      // The death is reported before any respawn is asked for, so a scorer sees
      // the loss even when the caller chose to respawn automatically.
      this.#emit({ kind: 'death', at, deaths: this.#deaths });
      if (this.#respawnMode === 'auto') this.requestRespawn();
    });

    const alive = () => {
      if (this.#status === 'alive') return;
      this.#status = 'alive';
      this.#emit({ kind: 'respawned', at: this.#now() });
    };
    bot.on('respawn', alive);
    bot.on('spawn', alive);

    bot.on('end', (...args: unknown[]) => {
      void this.#onEnd(args[0] === undefined ? 'connection ended' : describe(args[0]));
    });
    bot.on('kicked', (...args: unknown[]) => {
      void this.#onEnd(`kicked: ${describe(args[0])}`);
    });
  }

  async #onEnd(reason: string): Promise<void> {
    if (this.#closed) {
      // An intentional teardown. Reported once, and never reconnected.
      this.#log.info('session ended intentionally', { reason });
      return;
    }
    if (this.#reconnecting) return;
    this.#emit({ kind: 'disconnected', at: this.#now(), reason, intentional: false });
    await this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    const rejoin = this.#rejoin;
    if (rejoin === undefined || !this.#policy.enabled) {
      this.#emit({
        kind: 'reconnect-failed',
        at: this.#now(),
        reason: rejoin === undefined ? 'no rejoin was configured' : 'reconnect is disabled',
      });
      return;
    }

    this.#reconnecting = true;
    try {
      let lastError = 'no attempt was made';
      for (let attempt = 0; attempt < this.#policy.maxAttempts; attempt += 1) {
        if (this.#closed) return;
        // Two separate waits, and the longer wins: the backoff keeps a failing
        // server from being hammered, and the budget keeps the account inside
        // Mojang's six joins per thirty seconds however the backoff is tuned.
        const now = this.#now();
        const delay = Math.max(backoffDelay(attempt, this.#policy), this.#budget.waitFor(now));
        this.#emit({ kind: 'reconnecting', at: now, attempt: attempt + 1, delayMs: delay });
        await this.#sleep(delay);
        if (this.#closed) return;

        this.#budget.record(this.#now());
        try {
          const bot = await rejoin();
          this.#bot = bot;
          this.#generation += 1;
          this.#status = 'alive';
          this.#watch(bot);
          this.#log.info('reconnected', { generation: this.#generation });
          this.#emit({
            kind: 'reconnected',
            at: this.#now(),
            generation: this.#generation,
          });
          return;
        } catch (error) {
          lastError = describe(error);
          this.#log.error('reconnect attempt failed', { attempt, error: lastError });
        }
      }
      this.#emit({ kind: 'reconnect-failed', at: this.#now(), reason: lastError });
    } finally {
      this.#reconnecting = false;
    }
  }

  #emit(event: LifecycleEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
