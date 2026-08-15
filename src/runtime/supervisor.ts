import type { ActuatorPort } from '../embodiment/port.js';
import type { WorldView } from '../perception/world-view.js';
import type { ReflexArbiter } from '../skills/reflex/arbiter.js';
import type { Reflex, ReflexContext } from '../skills/reflex/types.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

/** How often the arbiter is evaluated when the caller does not say. */
export const DEFAULT_REFLEX_INTERVAL_MS = 100;

/** How many fires are kept for inspection before the oldest is dropped. */
export const DEFAULT_FIRE_HISTORY = 64;

/** One reflex firing, recorded whether or not its action succeeded. */
export interface ReflexFire {
  readonly reflex: string;
  /** When the reflex fired, on the session clock. */
  readonly at: number;
  /** How many skill runs were pre-empted by this firing. */
  readonly preempted: number;
  /** Set when the reflex action threw. */
  readonly error?: string;
}

/** The mutable half of {@link ReflexFire}, kept private to this module. */
interface FireRecord {
  readonly reflex: string;
  readonly at: number;
  readonly preempted: number;
  error?: string;
}

export interface ReflexSupervisorOptions {
  readonly world: WorldView;
  readonly arbiter: ReflexArbiter;
  readonly act: ActuatorPort;
  readonly clock: Clock;
  readonly log?: Logger;
  readonly historyLimit?: number;
}

/**
 * Ticks the arbiter, and is the only thing that does.
 *
 * The arbiter answers "what would fire here?" and is pure; something has to ask
 * it on a schedule, pre-empt whatever is running, and see the reflex action
 * through. Without this loop the reflexes are unreachable code and drowning
 * protection is a claim rather than a behaviour.
 *
 * Two rules shape everything below. Aborting is synchronous, because a skill
 * that keeps digging for another tick while we drown is the failure this exists
 * to prevent. Acting is not, because a reflex moves a body and that takes time.
 * Between the two, no second reflex is allowed to start: a body cannot climb
 * out of lava and flee a skeleton at once, and a reflex that re-fires every
 * tick while its own action is still running would issue a hundred pathfinder
 * goals a second.
 */
export class ReflexSupervisor {
  readonly #world: WorldView;
  readonly #arbiter: ReflexArbiter;
  readonly #act: ActuatorPort;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #historyLimit: number;

  /** Cancellation tokens of the runs currently in flight. */
  readonly #guarded = new Set<AbortController>();
  readonly #fires: FireRecord[] = [];

  #timer: ReturnType<typeof setInterval> | undefined;
  #firing: Reflex | undefined;
  #action: Promise<void> | undefined;

  constructor(options: ReflexSupervisorOptions) {
    this.#world = options.world;
    this.#arbiter = options.arbiter;
    this.#act = options.act;
    this.#clock = options.clock;
    this.#log = options.log ?? silentLogger;
    this.#historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_FIRE_HISTORY);
  }

  /** Whether the loop is running. */
  get started(): boolean {
    return this.#timer !== undefined;
  }

  /** The reflex whose action is in flight, if any. */
  get firing(): Reflex | undefined {
    return this.#firing;
  }

  /** Every firing so far, oldest first, capped by the history limit. */
  get fires(): readonly ReflexFire[] {
    return [...this.#fires];
  }

  /** How many runs are currently under this supervisor's protection. */
  get guarding(): number {
    return this.#guarded.size;
  }

  /**
   * Put a run under protection: when a reflex fires, this controller is
   * aborted. Returns the release function, which the caller must invoke when
   * the run settles so that a finished run is not aborted later.
   */
  guard(controller: AbortController): () => void {
    this.#guarded.add(controller);
    return () => {
      this.#guarded.delete(controller);
    };
  }

  /**
   * Begin evaluating on an interval. Starting twice is a no-op rather than an
   * error, so a caller that is not sure whether it started the loop cannot end
   * up with two of them.
   */
  start(intervalMs: number = DEFAULT_REFLEX_INTERVAL_MS): void {
    if (this.#timer !== undefined) return;
    if (!(intervalMs > 0)) {
      throw new RangeError(`reflex interval must be positive, got ${intervalMs}`);
    }
    const timer = setInterval(() => {
      this.tick();
    }, intervalMs);
    // A reflex loop must never be the reason a process refuses to exit.
    timer.unref?.();
    this.#timer = timer;
  }

  /** Halt the loop. Any action already in flight is left to finish. */
  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Evaluate once, and fire if something holds.
   *
   * Synchronous by design: it returns as soon as the pre-emption is done, and
   * the reflex action runs on its own. A caller wanting to wait for that action
   * uses {@link ReflexSupervisor.settle}.
   */
  tick(): Reflex | undefined {
    // Already acting. Re-evaluating now could only start a second action, and
    // a body that is climbing out of lava has nothing better to be doing.
    if (this.#firing !== undefined) return this.#firing;

    let reflex: Reflex | undefined;
    try {
      reflex = this.#arbiter.evaluate(this.#world);
    } catch (error) {
      // A read the profile forbids, or a body that is not there any more. The
      // loop must survive it: a supervisor that dies on one bad tick takes
      // every later reflex with it.
      this.#log.error('reflex evaluation failed', { error: messageOf(error) });
      return undefined;
    }
    if (reflex === undefined) return undefined;

    this.#firing = reflex;
    const preempted = this.#preempt(reflex);
    const record: FireRecord = { reflex: reflex.name, at: this.#clock.now(), preempted };
    this.#remember(record);
    this.#log.warn('reflex fired', { reflex: reflex.name, preempted });

    const ctx: ReflexContext = {
      world: this.#world,
      act: this.#act,
      clock: this.#clock,
      log: this.#log.child({ reflex: reflex.name }),
    };

    // Started, not awaited: the abort above has already happened, and the
    // action is allowed to take as long as moving a body takes.
    this.#action = (async () => {
      try {
        await reflex.act(ctx);
      } catch (error) {
        record.error = messageOf(error);
        this.#log.error('reflex action failed', {
          reflex: reflex.name,
          error: record.error,
        });
      } finally {
        this.#firing = undefined;
        this.#action = undefined;
      }
    })();

    return reflex;
  }

  /**
   * Resolve once no reflex action is in flight. Chained rather than awaited
   * once, because a reflex action can finish just as the next tick starts one.
   */
  async settle(): Promise<void> {
    while (this.#action !== undefined) {
      await this.#action;
    }
  }

  /** Abort every guarded run. Synchronous, and the whole point of the class. */
  #preempt(reflex: Reflex): number {
    let count = 0;
    for (const controller of this.#guarded) {
      if (controller.signal.aborted) continue;
      controller.abort(new Error(`pre-empted by reflex "${reflex.name}"`));
      count += 1;
    }
    return count;
  }

  #remember(record: FireRecord): void {
    this.#fires.push(record);
    while (this.#fires.length > this.#historyLimit) this.#fires.shift();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
