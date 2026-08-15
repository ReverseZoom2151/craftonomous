import type { Vec3Like } from '../../embodiment/geometry.js';
import type { BodyState } from '../../embodiment/types.js';
import type { WorldView } from '../../perception/world-view.js';
import type { Reflex, ReflexContext } from './types.js';
import { REFLEX_PRIORITY } from './types.js';

/**
 * Built-in reflexes.
 *
 * Every condition below reads only from `WorldView`, so a reflex is subject to
 * the same perception budget as everything else. A reflex that peeked at the
 * raw sensors would be an omniscience leak in the one place nobody audits.
 *
 * The actions are deliberately small. A reflex buys the deliberative layer a
 * second or two; it is not a plan, and pretending otherwise is how prior work
 * ends up with two planners fighting each other.
 */

/** Foods common enough to be worth trying without a recipe database. */
export const DEFAULT_FOODS: readonly string[] = [
  'golden_apple',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_cod',
  'cooked_salmon',
  'bread',
  'baked_potato',
  'carrot',
  'apple',
  'melon_slice',
  'sweet_berries',
];

export interface ReflexThresholds {
  /** Oxygen at or below this counts as drowning. Vanilla maximum is 20. */
  readonly oxygen: number;
  /** Health at or below this counts as an emergency. Vanilla maximum is 20. */
  readonly health: number;
  /** Food at or below this counts as starving. Vanilla maximum is 20. */
  readonly food: number;
  /** Blocks of clear air below the feet before a fall counts as dangerous. */
  readonly fallDepth: number;
  /** How far to look for water when burning. */
  readonly waterSearchRange: number;
  /** How far to run from whatever is hurting us. */
  readonly fleeDistance: number;
  /** Foods to try, most preferred first. */
  readonly foods: readonly string[];
}

export const DEFAULT_THRESHOLDS: ReflexThresholds = {
  oxygen: 6,
  health: 6,
  food: 6,
  fallDepth: 4,
  waterSearchRange: 16,
  fleeDistance: 8,
  foods: DEFAULT_FOODS,
};

function body(world: WorldView): BodyState {
  return world.body().value;
}

function above(p: Vec3Like, dy: number): Vec3Like {
  return { x: p.x, y: p.y + dy, z: p.z };
}

/**
 * True when we positively know there is nothing solid under our feet for
 * `depth` blocks. Unknown blocks do not count as air: an unseen block is not
 * an absent block, and firing on ignorance would make this reflex chatter
 * every time the agent walks past the edge of its sight range.
 */
function knownDropBelow(
  world: WorldView,
  from: Vec3Like,
  depth: number,
): boolean {
  for (let dy = 1; dy <= depth; dy += 1) {
    const seen = world.blockAt(above(from, -dy));
    if (!seen) return false;
    if (seen.value.solid) return false;
  }
  return true;
}

export function inLavaReflex(
  _thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'in-lava',
    priority: REFLEX_PRIORITY.IN_LAVA,
    shouldFire: (world) => body(world).inLava,
    async act(ctx: ReflexContext): Promise<void> {
      const self = body(ctx.world);
      ctx.log.warn('reflex: in lava, climbing out');
      await ctx.act.stop();
      // Up first: lava is survivable for a few ticks and the surface is the
      // only direction that is reliably not more lava.
      await ctx.act.moveTo(above(self.position, 2), { range: 1 });
    },
  };
}

export function drowningReflex(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'drowning',
    priority: REFLEX_PRIORITY.DROWNING,
    shouldFire: (world) => {
      const self = body(world);
      return self.inWater && self.oxygen <= thresholds.oxygen;
    },
    async act(ctx: ReflexContext): Promise<void> {
      const self = body(ctx.world);
      ctx.log.warn('reflex: drowning, surfacing', { oxygen: self.oxygen });
      await ctx.act.stop();
      await ctx.act.moveTo(above(self.position, 4), { range: 1 });
    },
  };
}

export function onFireReflex(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'on-fire',
    priority: REFLEX_PRIORITY.ON_FIRE,
    shouldFire: (world) => {
      const self = body(world);
      // Already in water: the fire is going out on its own.
      return self.isBurning && !self.inWater;
    },
    async act(ctx: ReflexContext): Promise<void> {
      ctx.log.warn('reflex: burning, looking for water');
      const water = ctx.world.findBlocks({
        names: ['water'],
        maxDistance: thresholds.waterSearchRange,
        limit: 1,
      })[0];
      if (water) {
        await ctx.act.moveTo(water.value.position, { range: 1 });
        return;
      }
      // Nothing to douse ourselves in; at least stop walking further into it.
      await ctx.act.stop();
    },
  };
}

export function fallingReflex(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'falling',
    priority: REFLEX_PRIORITY.FALLING,
    shouldFire: (world) => {
      const self = body(world);
      if (self.onGround || self.inWater || self.inLava) return false;
      return knownDropBelow(world, self.position, thresholds.fallDepth);
    },
    async act(ctx: ReflexContext): Promise<void> {
      const self = body(ctx.world);
      ctx.log.warn('reflex: falling, cancelling movement');
      // There is no honest recovery from a fall without a bucket or a block to
      // place, so this stops the pathfinder from steering us further out and
      // points us at the ground for whatever lands next.
      await ctx.act.stop();
      await ctx.act.lookAt(above(self.position, -thresholds.fallDepth));
    },
  };
}

export function lowHealthReflex(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'low-health',
    priority: REFLEX_PRIORITY.LOW_HEALTH,
    shouldFire: (world) => body(world).health <= thresholds.health,
    async act(ctx: ReflexContext): Promise<void> {
      const self = body(ctx.world);
      ctx.log.warn('reflex: low health, disengaging', { health: self.health });
      const threat = ctx.world
        .nearbyEntities({ maxDistance: thresholds.fleeDistance * 2 })
        .find((e) => e.value.hostile === true);
      if (!threat) {
        await ctx.act.stop();
        return;
      }
      const from = threat.value.position;
      const dx = self.position.x - from.x;
      const dz = self.position.z - from.z;
      const len = Math.hypot(dx, dz);
      const unit = len === 0 ? { x: 1, z: 0 } : { x: dx / len, z: dz / len };
      await ctx.act.moveTo(
        {
          x: self.position.x + unit.x * thresholds.fleeDistance,
          y: self.position.y,
          z: self.position.z + unit.z * thresholds.fleeDistance,
        },
        { range: 2 },
      );
    },
  };
}

export function starvingReflex(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): Reflex {
  return {
    name: 'starving',
    priority: REFLEX_PRIORITY.STARVING,
    shouldFire: (world) => {
      const self = body(world);
      if (self.food > thresholds.food) return false;
      // Only fire when eating is actually possible; a reflex that cannot act
      // is noise that masks the reflexes that can.
      const carried = world.inventory().value;
      return carried.some(
        (s) => s.count > 0 && thresholds.foods.includes(s.name),
      );
    },
    async act(ctx: ReflexContext): Promise<void> {
      const carried = ctx.world.inventory().value;
      for (const name of thresholds.foods) {
        const stack = carried.find((s) => s.name === name && s.count > 0);
        if (!stack) continue;
        ctx.log.info('reflex: eating', { item: name });
        const outcome = await ctx.act.consume(name);
        if (outcome.ok) return;
      }
    },
  };
}

/** Every built-in reflex, in no particular order; the arbiter sorts them. */
export function builtinReflexes(
  thresholds: ReflexThresholds = DEFAULT_THRESHOLDS,
): readonly Reflex[] {
  return [
    inLavaReflex(thresholds),
    drowningReflex(thresholds),
    onFireReflex(thresholds),
    fallingReflex(thresholds),
    lowHealthReflex(thresholds),
    starvingReflex(thresholds),
  ];
}
