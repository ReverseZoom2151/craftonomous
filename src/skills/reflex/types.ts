import type { ActuatorPort } from '../../embodiment/port.js';
import type { WorldView } from '../../perception/world-view.js';
import type { Clock } from '../../runtime/clock.js';
import type { Logger } from '../../runtime/logger.js';

/**
 * What a reflex is given when it fires.
 *
 * Deliberately the same shape as a `SkillContext` minus the signal: a reflex is
 * the thing that does the cancelling, so it is not itself cancellable.
 */
export interface ReflexContext {
  readonly world: WorldView;
  readonly act: ActuatorPort;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * A standing response to a situation the deliberative layer is too slow for.
 *
 * `shouldFire` must be synchronous, cheap and side-effect free: it is called on
 * every tick, and a reflex that reasons is not a reflex.
 */
export interface Reflex {
  readonly name: string;
  /** Higher wins. Ties are broken by registration order. */
  readonly priority: number;
  shouldFire(world: WorldView): boolean;
  act(ctx: ReflexContext): Promise<void>;
}

/**
 * Priority bands for the built-in reflexes.
 *
 * Ordered by how fast the situation kills you. Lava and drowning are measured
 * in seconds and are not survivable by fighting back, so they outrank low
 * health, which is survivable by fleeing. Hunger outranks nothing.
 */
export const REFLEX_PRIORITY = {
  IN_LAVA: 100,
  DROWNING: 90,
  ON_FIRE: 80,
  FALLING: 70,
  LOW_HEALTH: 60,
  STARVING: 30,
} as const;
