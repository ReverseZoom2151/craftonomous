import { z } from 'zod';
import { blockCentre, distance } from '../../embodiment/geometry.js';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  REACH,
  bodyPosition,
  guarded,
  interruptCheck,
  inventoryCounts,
  isAirLike,
  moveWithin,
  nearestBlock,
  show,
  totalGained,
  vec3Schema,
} from './support.js';

/* ------------------------------------------------------------------ */
/* digBlock                                                            */
/* ------------------------------------------------------------------ */

const digBlockInput = z.object({
  position: vec3Schema,
  /** Refuse to dig unless the block still has this name. */
  expect: z.string().min(1).optional(),
});
const digBlockOutput = z.object({
  position: vec3Schema,
  name: z.string(),
  /** Items that appeared in the inventory as a result. Zero is not an error. */
  collected: z.number().int(),
});

export type DigBlockInput = z.infer<typeof digBlockInput>;
export type DigBlockOutput = z.infer<typeof digBlockOutput>;

export const digBlock: Skill<DigBlockInput, DigBlockOutput> = {
  name: 'digBlock',
  summary: 'Break the block at a coordinate, reporting what was picked up.',
  description: [
    'Digs one known, non-air block and reports the net gain in inventory.',
    'A gain of zero is a success: gravel drops nothing most of the time, and',
    'drops that land outside pickup range are still a broken block.',
    'The precondition requires the space to be *known* — a coordinate the',
    'agent has never sensed fails rather than swinging blindly at fog. Digging',
    'a block that changed between the check and the swing fails',
    '`world-changed`; a block outside arm\'s reach fails `unreachable`, and the',
    'remedy there is `goToPosition` first.',
    'Do not use this to gather a quantity of something — `collectBlock` finds,',
    'approaches and repeats.',
  ].join(' '),
  input: digBlockInput,
  output: digBlockOutput,
  precondition: (ctx, input) => {
    const seen = ctx.world.blockAt(input.position);
    if (!seen) {
      return Promise.resolve(
        fails(
          `nothing is known about ${show(input.position)}; it is out of sight, not necessarily empty`,
        ),
      );
    }
    if (isAirLike(seen.value.name)) {
      return Promise.resolve(
        fails(`${show(input.position)} holds ${seen.value.name}, which cannot be dug`),
      );
    }
    if (input.expect !== undefined && seen.value.name !== input.expect) {
      return Promise.resolve(
        fails(
          `expected ${input.expect} at ${show(input.position)} but sensed ${seen.value.name}`,
        ),
      );
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<DigBlockOutput>(ctx, elapsed, 'before digging');
      if (interrupted) return interrupted;

      const seen = ctx.world.blockAt(input.position);
      if (!seen || isAirLike(seen.value.name)) {
        return fail(
          'world-changed',
          `${show(input.position)} no longer holds a diggable block${
            seen ? ` (it is ${seen.value.name})` : ''
          }`,
          elapsed(),
        );
      }
      if (input.expect !== undefined && seen.value.name !== input.expect) {
        return fail(
          'world-changed',
          `${show(input.position)} became ${seen.value.name}, not the expected ${input.expect}`,
          elapsed(),
        );
      }

      const centre = blockCentre(input.position);
      const reach = distance(bodyPosition(ctx), centre);
      if (reach > REACH) {
        return fail(
          'unreachable',
          `${show(input.position)} is ${reach.toFixed(1)} blocks away, beyond a reach of ${REACH}`,
          elapsed(),
        );
      }

      const before = inventoryCounts(ctx);
      const outcome = await ctx.act.dig(input.position, { signal: ctx.signal });
      if (!outcome.ok) {
        const stopped = interruptCheck<DigBlockOutput>(ctx, elapsed, 'while digging');
        if (stopped) return stopped;
        return fail(
          'unknown',
          `digging ${seen.value.name} at ${show(input.position)} failed: ${
            outcome.detail ?? 'no detail given'
          }`,
          elapsed(),
        );
      }

      const after = ctx.world.blockAt(input.position);
      if (after && after.value.name === seen.value.name) {
        return fail(
          'unknown',
          `the ${seen.value.name} at ${show(input.position)} is still there after digging`,
          elapsed(),
        );
      }

      return succeed(
        {
          position: input.position,
          name: seen.value.name,
          collected: totalGained(before, inventoryCounts(ctx)),
        },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* collectBlock                                                        */
/* ------------------------------------------------------------------ */

const collectBlockInput = z.object({
  name: z.string().min(1),
  /** How many blocks to break. Defaults to 1. */
  count: z.number().int().min(1).max(256).optional(),
  /** How far to search for each one. Defaults to 32. */
  maxDistance: z.number().min(1).max(256).optional(),
});
const collectBlockOutput = z.object({
  name: z.string(),
  requested: z.number().int(),
  /** Blocks actually broken. */
  dug: z.number().int(),
  /** Net items gained across the whole run, which may differ from `dug`. */
  collected: z.number().int(),
});

export type CollectBlockInput = z.infer<typeof collectBlockInput>;
export type CollectBlockOutput = z.infer<typeof collectBlockOutput>;

export const collectBlock: Skill<CollectBlockInput, CollectBlockOutput> = {
  name: 'collectBlock',
  summary: 'Find, approach and break a number of blocks of one type.',
  description: [
    'Repeats find-approach-dig until `count` blocks are broken. Item gain is',
    'measured against the inventory, so smelting-ore drops (`iron_ore` giving',
    '`raw_iron`) are counted honestly rather than assumed one-for-one.',
    'Finding nothing known of that name fails `unreachable` — the block may',
    'exist unsensed, and the remedy is to explore, not to retry in place.',
    'A partial haul is a success with `dug` below `requested`, so the caller',
    'can decide whether to continue; only a haul of zero fails.',
    'Do not use this when the coordinate is already known — `digBlock` skips',
    'the search and is honest about what it did.',
  ].join(' '),
  input: collectBlockInput,
  output: collectBlockOutput,
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const wanted = input.count ?? 1;
      const maxDistance = input.maxDistance ?? 32;
      const before = inventoryCounts(ctx);
      let dug = 0;
      let lastFailure = '';
      // Each block may cost an extra attempt to a vanished or blocked
      // candidate, so allow slack without ever looping unboundedly.
      const maxAttempts = wanted * 3;

      for (let attempt = 0; attempt < maxAttempts && dug < wanted; attempt += 1) {
        const stopped = interruptCheck<CollectBlockOutput>(
          ctx,
          elapsed,
          `after digging ${dug} of ${wanted}`,
        );
        if (stopped) return stopped;

        const target = nearestBlock(ctx, [input.name], maxDistance);
        if (!target) {
          if (dug > 0) break;
          if (lastFailure) {
            // Something was known a moment ago and is not any more; that is a
            // different remedy from never having sensed one at all.
            return fail('world-changed', `broke no ${input.name}: ${lastFailure}`, elapsed());
          }
          return fail(
            'unreachable',
            `no ${input.name} is known within ${maxDistance} blocks; it may exist but has not been sensed`,
            elapsed(),
          );
        }
        const at = target.value.position;
        const centre = blockCentre(at);

        if (distance(bodyPosition(ctx), centre) > REACH - 1) {
          const moved = await moveWithin(ctx, centre, 2);
          if (!moved.ok) {
            lastFailure = `could not reach the ${input.name} at ${show(at)}: ${moved.detail}`;
            continue;
          }
        }

        const still = ctx.world.blockAt(at);
        if (!still || still.value.name !== input.name) {
          lastFailure = `the ${input.name} at ${show(at)} vanished before it could be dug`;
          continue;
        }

        const outcome = await ctx.act.dig(at, { signal: ctx.signal });
        if (!outcome.ok) {
          const interrupted = interruptCheck<CollectBlockOutput>(
            ctx,
            elapsed,
            `while digging block ${dug + 1}`,
          );
          if (interrupted) return interrupted;
          lastFailure = `digging ${show(at)} failed: ${outcome.detail ?? 'no detail given'}`;
          continue;
        }
        dug += 1;
      }

      const collected = totalGained(before, inventoryCounts(ctx));
      if (dug === 0) {
        return fail(
          'world-changed',
          `broke no ${input.name}: ${lastFailure || 'every candidate was gone by the time it was reached'}`,
          elapsed(),
        );
      }
      return succeed({ name: input.name, requested: wanted, dug, collected }, elapsed());
    }),
};
