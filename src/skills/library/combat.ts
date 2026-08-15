import { z } from 'zod';
import { distance } from '../../embodiment/geometry.js';
import type { EntityInfo } from '../../embodiment/types.js';
import type { Observed } from '../../observation/observed.js';
import type { Skill, SkillContext } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  bodyPosition,
  entityById,
  guarded,
  interruptCheck,
  moveWithin,
  nearestEntity,
} from './support.js';

/** How close the body must be for a swing to land. */
const MELEE_RANGE = 3.5;

const attackEntityInput = z
  .object({
    /** Entity type name or player username. Give this or `entityId`. */
    name: z.string().min(1).optional(),
    /** Exact entity id, when one is already known from an earlier read. */
    entityId: z.number().int().optional(),
    maxDistance: z.number().min(1).max(64).optional(),
    /** Give up after this many swings. Defaults to 20. */
    maxSwings: z.number().int().min(1).max(200).optional(),
    /** Whether to close the distance. Defaults to true. */
    approach: z.boolean().optional(),
  })
  .refine((v) => (v.name === undefined) !== (v.entityId === undefined), {
    message: 'give exactly one of `name` or `entityId`',
  });
const attackEntityOutput = z.object({
  entityId: z.number(),
  name: z.string(),
  swings: z.number().int(),
  /** True when the target stopped being sensed or its health reached zero. */
  defeated: z.boolean(),
  remainingHealth: z.number().optional(),
});

export type AttackEntityInput = z.infer<typeof attackEntityInput>;
export type AttackEntityOutput = z.infer<typeof attackEntityOutput>;

function findTarget(
  ctx: SkillContext,
  input: AttackEntityInput,
  maxDistance: number,
): Observed<EntityInfo> | undefined {
  if (input.entityId !== undefined) return entityById(ctx, input.entityId, maxDistance);
  return nearestEntity(ctx, input.name ?? '', maxDistance);
}

function describe(input: AttackEntityInput): string {
  return input.entityId !== undefined ? `entity #${input.entityId}` : `"${input.name ?? ''}"`;
}

export const attackEntity: Skill<AttackEntityInput, AttackEntityOutput> = {
  name: 'attackEntity',
  summary: 'Swing at an entity until it dies or the swing budget runs out.',
  description: [
    'Closes to melee range and attacks, re-reading the target between swings',
    'so a mob that moves is followed and a mob that dies ends the loop.',
    'A target that stops being sensed after at least one landed swing is',
    'reported as defeated — that is what death looks like from the outside,',
    'and the caller is told the swing count so it can judge for itself. A',
    'target that was never sensed fails the precondition, and one that',
    'disappears before the first swing fails `world-changed`.',
    'Surviving the swing budget fails `timeout` rather than fighting forever;',
    'that is the signal to equip a better weapon or to `flee`.',
    'Do not use this to break blocks — that is `digBlock`. Nothing here checks',
    'that the fight is winnable, so pair it with a health reflex.',
  ].join(' '),
  input: attackEntityInput,
  output: attackEntityOutput,
  precondition: (ctx, input) => {
    const maxDistance = input.maxDistance ?? 16;
    const target = findTarget(ctx, input, maxDistance);
    return Promise.resolve(
      target
        ? HOLDS
        : fails(`${describe(input)} is not sensed within ${maxDistance} blocks`),
    );
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const maxDistance = input.maxDistance ?? 16;
      const maxSwings = input.maxSwings ?? 20;
      const approach = input.approach ?? true;

      const first = findTarget(ctx, input, maxDistance);
      if (!first) {
        return fail(
          'world-changed',
          `${describe(input)} is no longer sensed within ${maxDistance} blocks`,
          elapsed(),
        );
      }
      const id = first.value.id;
      const name = first.value.name;
      let swings = 0;
      let lastHealth = first.value.health;

      while (swings < maxSwings) {
        const stopped = interruptCheck<AttackEntityOutput>(
          ctx,
          elapsed,
          `after ${swings} swings`,
        );
        if (stopped) return stopped;

        const target = entityById(ctx, id, maxDistance);
        if (!target) {
          if (swings === 0) {
            return fail(
              'world-changed',
              `${name}#${id} vanished before the first swing`,
              elapsed(),
            );
          }
          return succeed(
            { entityId: id, name, swings, defeated: true },
            elapsed(),
          );
        }
        lastHealth = target.value.health;
        if (lastHealth !== undefined && lastHealth <= 0) {
          return succeed(
            { entityId: id, name, swings, defeated: true, remainingHealth: 0 },
            elapsed(),
          );
        }

        const gap = distance(bodyPosition(ctx), target.value.position);
        if (gap > MELEE_RANGE) {
          if (!approach) {
            return fail(
              'unreachable',
              `${name}#${id} is ${gap.toFixed(1)} blocks away and approaching was not allowed`,
              elapsed(),
            );
          }
          const moved = await moveWithin(ctx, target.value.position, MELEE_RANGE - 1);
          if (!moved.ok) {
            const interrupted = interruptCheck<AttackEntityOutput>(
              ctx,
              elapsed,
              'while closing in',
            );
            if (interrupted) return interrupted;
            return fail(
              'unreachable',
              `could not close on ${name}#${id}: ${moved.detail}`,
              elapsed(),
            );
          }
        }

        const outcome = await ctx.act.attack(id);
        if (!outcome.ok) {
          const interrupted = interruptCheck<AttackEntityOutput>(ctx, elapsed, 'mid-swing');
          if (interrupted) return interrupted;
          return fail(
            'unknown',
            `swing at ${name}#${id} failed: ${outcome.detail ?? 'no detail given'}`,
            elapsed(),
          );
        }
        swings += 1;
      }

      return fail(
        'timeout',
        `${name}#${id} survived ${maxSwings} swings${
          lastHealth !== undefined ? ` and still has ${lastHealth} health` : ''
        }`,
        elapsed(),
      );
    }),
};
