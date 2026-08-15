import type { WorldView } from '../../perception/world-view.js';
import type { Reflex } from './types.js';

/**
 * Picks at most one reflex per tick.
 *
 * Pure and synchronous by construction so that it can be ticked at whatever
 * rate the substrate produces state without becoming the bottleneck, and so
 * that "which reflex would fire here?" is a question a test can ask directly.
 */
export class ReflexArbiter {
  /** Kept sorted by descending priority; ties keep registration order. */
  readonly #reflexes: Reflex[] = [];

  constructor(reflexes: readonly Reflex[] = []) {
    for (const r of reflexes) this.add(r);
  }

  add(reflex: Reflex): this {
    // Insert before the first strictly lower priority, so equal priorities
    // stay in the order they were registered.
    const at = this.#reflexes.findIndex((r) => r.priority < reflex.priority);
    if (at === -1) this.#reflexes.push(reflex);
    else this.#reflexes.splice(at, 0, reflex);
    return this;
  }

  addAll(reflexes: Iterable<Reflex>): this {
    for (const r of reflexes) this.add(r);
    return this;
  }

  remove(name: string): boolean {
    const at = this.#reflexes.findIndex((r) => r.name === name);
    if (at === -1) return false;
    this.#reflexes.splice(at, 1);
    return true;
  }

  /** The highest-priority reflex whose condition holds, or undefined. */
  evaluate(world: WorldView): Reflex | undefined {
    for (const reflex of this.#reflexes) {
      if (reflex.shouldFire(world)) return reflex;
    }
    return undefined;
  }

  /** Every reflex whose condition holds, highest priority first. */
  evaluateAll(world: WorldView): readonly Reflex[] {
    return this.#reflexes.filter((r) => r.shouldFire(world));
  }

  /**
   * Evaluate and, if something fires, pre-empt the running skill by aborting
   * the controller that owns its signal. The reflex is returned so the caller
   * can `act` on it; aborting and acting are kept separate because the abort
   * must happen synchronously and the action must not.
   */
  preempt(world: WorldView, running: AbortController): Reflex | undefined {
    const reflex = this.evaluate(world);
    if (reflex && !running.signal.aborted) {
      running.abort(new Error(`pre-empted by reflex "${reflex.name}"`));
    }
    return reflex;
  }

  list(): readonly Reflex[] {
    return [...this.#reflexes];
  }

  get size(): number {
    return this.#reflexes.length;
  }
}
