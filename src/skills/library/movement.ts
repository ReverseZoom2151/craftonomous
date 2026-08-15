import { z } from 'zod';
import type { Vec3Like } from '../../embodiment/geometry.js';
import {
  add,
  blockCentre,
  distance,
  normalize,
  scale,
  subtract,
} from '../../embodiment/geometry.js';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  bodyPosition,
  guarded,
  interruptCheck,
  moveWithin,
  nearestBlock,
  nearestEntity,
  show,
  vec3Schema,
} from './support.js';

/* ------------------------------------------------------------------ */
/* goToPosition                                                        */
/* ------------------------------------------------------------------ */

const goToPositionInput = z.object({
  position: vec3Schema,
  /** How close counts as arrived, in blocks. Defaults to 1. */
  range: z.number().min(0).max(64).optional(),
});
const goToPositionOutput = z.object({
  position: vec3Schema,
  distance: z.number(),
  /** True when the body was already inside `range` and nothing was done. */
  alreadyThere: z.boolean(),
});

export type GoToPositionInput = z.infer<typeof goToPositionInput>;
export type GoToPositionOutput = z.infer<typeof goToPositionOutput>;

export const goToPosition: Skill<GoToPositionInput, GoToPositionOutput> = {
  name: 'goToPosition',
  summary: 'Walk to a coordinate, stopping once within a range tolerance.',
  description: [
    'Paths to `position` and reports where the body actually ended up, read',
    'back from proprioception rather than taken on the pathfinder\'s word.',
    'Fails `unreachable` when no path exists or when the mover claims success',
    'without arriving.',
    'Do not use this to reach a block you intend to dig or place against;',
    '`goToBlock` finds the block first and stops within reach of it. Do not',
    'use it to chase something that moves; use `goToEntity`.',
  ].join(' '),
  input: goToPositionInput,
  output: goToPositionOutput,
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const range = input.range ?? 1;
      const interrupted = interruptCheck<GoToPositionOutput>(
        ctx,
        elapsed,
        'before moving',
      );
      if (interrupted) return interrupted;

      const startDistance = distance(bodyPosition(ctx), input.position);
      if (startDistance <= range) {
        return succeed(
          { position: bodyPosition(ctx), distance: startDistance, alreadyThere: true },
          elapsed(),
        );
      }

      const moved = await moveWithin(ctx, input.position, range);
      if (!moved.ok) {
        const stillGoing = interruptCheck<GoToPositionOutput>(
          ctx,
          elapsed,
          'while moving',
        );
        if (stillGoing) return stillGoing;
        return fail(
          'unreachable',
          `could not reach ${show(input.position)}: ${moved.detail}`,
          elapsed(),
        );
      }

      const here = bodyPosition(ctx);
      return succeed(
        { position: here, distance: distance(here, input.position), alreadyThere: false },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* goToBlock                                                           */
/* ------------------------------------------------------------------ */

const goToBlockInput = z.object({
  /** Block name without a namespace, e.g. `iron_ore`. */
  name: z.string().min(1),
  /** How far to search. Defaults to 32 blocks. */
  maxDistance: z.number().min(1).max(256).optional(),
  /** How close to stand. Defaults to 2 blocks, which is within reach. */
  range: z.number().min(0).max(16).optional(),
});
const goToBlockOutput = z.object({
  name: z.string(),
  position: vec3Schema,
  distance: z.number(),
  /** How the block's location was known: `sight`, `memory`, and so on. */
  provenance: z.string(),
});

export type GoToBlockInput = z.infer<typeof goToBlockInput>;
export type GoToBlockOutput = z.infer<typeof goToBlockOutput>;

export const goToBlock: Skill<GoToBlockInput, GoToBlockOutput> = {
  name: 'goToBlock',
  summary: 'Walk to the nearest known block of a named type and stand beside it.',
  description: [
    'Searches what the agent can currently sense or recall for the nearest',
    'block of this name, then paths to within reach of it and confirms the',
    'block is still there.',
    'A block the agent has never sensed is *unknown*, not absent: that case',
    'fails `unreachable` rather than guessing a direction, and the remedy is',
    'to explore. A block that has been mined or replaced since it was last',
    'seen fails `world-changed`.',
    'Do not use this when you already have exact coordinates; `goToPosition`',
    'is cheaper and does not depend on the block still existing.',
  ].join(' '),
  input: goToBlockInput,
  output: goToBlockOutput,
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const maxDistance = input.maxDistance ?? 32;
      const range = input.range ?? 2;
      const interrupted = interruptCheck<GoToBlockOutput>(ctx, elapsed, 'before moving');
      if (interrupted) return interrupted;

      const target = nearestBlock(ctx, [input.name], maxDistance);
      if (!target) {
        return fail(
          'unreachable',
          `no ${input.name} is known within ${maxDistance} blocks; it may exist but has not been sensed`,
          elapsed(),
        );
      }

      const centre = blockCentre(target.value.position);
      const moved = await moveWithin(ctx, centre, range);
      if (!moved.ok) {
        const stillGoing = interruptCheck<GoToBlockOutput>(ctx, elapsed, 'while moving');
        if (stillGoing) return stillGoing;
        return fail(
          'unreachable',
          `could not reach the ${input.name} at ${show(target.value.position)}: ${moved.detail}`,
          elapsed(),
        );
      }

      const nowThere = ctx.world.blockAt(target.value.position);
      if (!nowThere || nowThere.value.name !== input.name) {
        return fail(
          'world-changed',
          `the ${input.name} at ${show(target.value.position)} is gone; ${
            nowThere ? `there is now ${nowThere.value.name}` : 'the space is no longer sensed'
          }`,
          elapsed(),
        );
      }

      return succeed(
        {
          name: input.name,
          position: target.value.position,
          distance: distance(bodyPosition(ctx), centre),
          provenance: nowThere.provenance,
        },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* goToEntity                                                          */
/* ------------------------------------------------------------------ */

const goToEntityInput = z.object({
  /** Entity type name (`cow`, `zombie`) or a player's username. */
  name: z.string().min(1),
  maxDistance: z.number().min(1).max(128).optional(),
  range: z.number().min(0).max(16).optional(),
});
const goToEntityOutput = z.object({
  entityId: z.number(),
  name: z.string(),
  position: vec3Schema,
  distance: z.number(),
});

export type GoToEntityInput = z.infer<typeof goToEntityInput>;
export type GoToEntityOutput = z.infer<typeof goToEntityOutput>;

export const goToEntity: Skill<GoToEntityInput, GoToEntityOutput> = {
  name: 'goToEntity',
  summary: 'Approach the nearest sensed entity with a given name or username.',
  description: [
    'Finds the nearest entity currently sensed whose type name or username',
    'matches, then paths to within `range` of where it was seen.',
    'Entities move, so the final distance is measured against the entity\'s',
    'position after the approach, and an entity that left sensing range',
    'during the walk fails `world-changed`.',
    'Do not use this to fight; `attackEntity` approaches and swings. Do not',
    'use it to reach a chest or a furnace; those are blocks, so use',
    '`goToBlock`.',
  ].join(' '),
  input: goToEntityInput,
  output: goToEntityOutput,
  precondition: (ctx, input) => {
    const maxDistance = input.maxDistance ?? 32;
    const found = nearestEntity(ctx, input.name, maxDistance);
    return Promise.resolve(
      found
        ? HOLDS
        : fails(
            `no entity named "${input.name}" is sensed within ${maxDistance} blocks`,
          ),
    );
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const maxDistance = input.maxDistance ?? 32;
      const range = input.range ?? 2;
      const interrupted = interruptCheck<GoToEntityOutput>(ctx, elapsed, 'before moving');
      if (interrupted) return interrupted;

      const target = nearestEntity(ctx, input.name, maxDistance);
      if (!target) {
        return fail(
          'world-changed',
          `no entity named "${input.name}" is sensed within ${maxDistance} blocks`,
          elapsed(),
        );
      }
      const id = target.value.id;

      const moved = await moveWithin(ctx, target.value.position, range);
      if (!moved.ok) {
        const stillGoing = interruptCheck<GoToEntityOutput>(ctx, elapsed, 'while moving');
        if (stillGoing) return stillGoing;
        return fail(
          'unreachable',
          `could not reach ${input.name}#${id}: ${moved.detail}`,
          elapsed(),
        );
      }

      const after = ctx.world
        .nearbyEntities({ maxDistance })
        .find((e) => e.value.id === id);
      if (!after) {
        return fail(
          'world-changed',
          `${input.name}#${id} is no longer sensed after the approach`,
          elapsed(),
        );
      }

      return succeed(
        {
          entityId: id,
          name: after.value.name,
          position: after.value.position,
          distance: distance(bodyPosition(ctx), after.value.position),
        },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* lookAt                                                              */
/* ------------------------------------------------------------------ */

const lookAtInput = z.object({
  position: vec3Schema,
  /** Aim at the centre of the containing block rather than the raw point. */
  centreOnBlock: z.boolean().optional(),
});
const lookAtOutput = z.object({
  position: vec3Schema,
  yaw: z.number(),
  pitch: z.number(),
});

export type LookAtInput = z.infer<typeof lookAtInput>;
export type LookAtOutput = z.infer<typeof lookAtOutput>;

export const lookAt: Skill<LookAtInput, LookAtOutput> = {
  name: 'lookAt',
  summary: 'Turn the head to face a position.',
  description: [
    'Points the body at a coordinate and reports the resulting yaw and pitch',
    'read back from proprioception. Cheap, and safe to call speculatively.',
    'Do not use this before digging, placing or attacking: those aim for',
    'themselves, and an extra turn is a wasted action in the reliability',
    'record. Use it for observation, for gestures, or to bring a target inside',
    'a line-of-sight-limited perception profile.',
  ].join(' '),
  input: lookAtInput,
  output: lookAtOutput,
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<LookAtOutput>(ctx, elapsed, 'before looking');
      if (interrupted) return interrupted;
      const target = input.centreOnBlock ? blockCentre(input.position) : input.position;
      const outcome = await ctx.act.lookAt(target);
      if (!outcome.ok) {
        return fail(
          'unknown',
          `could not look at ${show(target)}: ${outcome.detail ?? 'no detail given'}`,
          elapsed(),
        );
      }
      const body = ctx.world.body().value;
      return succeed(
        { position: target, yaw: body.yaw, pitch: body.pitch },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* flee                                                                */
/* ------------------------------------------------------------------ */

const fleeInput = z
  .object({
    /** Flee from a fixed point. Give this or `entityName`, not both. */
    position: vec3Schema.optional(),
    /** Flee from the nearest entity with this name or username. */
    entityName: z.string().min(1).optional(),
    /** How much space to put between body and threat. Defaults to 16. */
    minDistance: z.number().min(1).max(128).optional(),
  })
  .refine(
    (v) => (v.position === undefined) !== (v.entityName === undefined),
    { message: 'give exactly one of `position` or `entityName`' },
  );
const fleeOutput = z.object({
  from: vec3Schema,
  position: vec3Schema,
  distance: z.number(),
  /** False when the body was already far enough away and did not move. */
  moved: z.boolean(),
});

export type FleeInput = z.infer<typeof fleeInput>;
export type FleeOutput = z.infer<typeof fleeOutput>;

export const flee: Skill<FleeInput, FleeOutput> = {
  name: 'flee',
  summary: 'Retreat until a position or entity is at least a set distance away.',
  description: [
    'Walks directly away from a threat until `minDistance` blocks separate it',
    'from the body, and verifies the separation afterwards rather than',
    'assuming the retreat worked.',
    'It flees in a straight line, so it will not escape a dead end: a retreat',
    'that ends up short fails `unreachable`, which is the signal to fight, dig',
    'out, or pick a different bearing. Do not use it as a general mover.',
  ].join(' '),
  input: fleeInput,
  output: fleeOutput,
  precondition: (ctx, input) => {
    if (input.position) return Promise.resolve(HOLDS);
    const name = input.entityName ?? '';
    const found = nearestEntity(ctx, name, 64);
    return Promise.resolve(
      found ? HOLDS : fails(`no entity named "${name}" is sensed, so there is nothing to flee`),
    );
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const minDistance = input.minDistance ?? 16;
      const interrupted = interruptCheck<FleeOutput>(ctx, elapsed, 'before fleeing');
      if (interrupted) return interrupted;

      let threat: Vec3Like;
      if (input.position) {
        threat = input.position;
      } else {
        const found = nearestEntity(ctx, input.entityName ?? '', 64);
        if (!found) {
          return fail(
            'world-changed',
            `the entity named "${input.entityName ?? ''}" is no longer sensed`,
            elapsed(),
          );
        }
        threat = found.value.position;
      }

      const here = bodyPosition(ctx);
      const gap = distance(here, threat);
      if (gap >= minDistance) {
        return succeed({ from: threat, position: here, distance: gap, moved: false }, elapsed());
      }

      let away = normalize(subtract(here, threat));
      if (away.x === 0 && away.y === 0 && away.z === 0) away = { x: 1, y: 0, z: 0 };
      // Overshoot slightly so arriving at the edge of `range` still clears the
      // threshold rather than landing exactly on it.
      const target = add(here, scale(away, minDistance - gap + 2));

      const moved = await moveWithin(ctx, target, 2);
      const here2 = bodyPosition(ctx);
      const gap2 = distance(here2, threat);
      if (gap2 >= minDistance) {
        return succeed({ from: threat, position: here2, distance: gap2, moved: true }, elapsed());
      }

      const stillGoing = interruptCheck<FleeOutput>(ctx, elapsed, 'while fleeing');
      if (stillGoing) return stillGoing;
      return fail(
        'unreachable',
        `retreat stalled ${gap2.toFixed(1)} blocks from ${show(threat)}, short of ${minDistance}${
          moved.ok ? '' : `: ${moved.detail}`
        }`,
        elapsed(),
      );
    }),
};
