import { z } from 'zod';
import { add, blockCentre, distance } from '../../embodiment/geometry.js';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  REACH,
  bodyPosition,
  guarded,
  heldCount,
  interruptCheck,
  isAirLike,
  isUnitFace,
  show,
  vec3Schema,
} from './support.js';

const placeBlockInput = z.object({
  /** Inventory item to place, e.g. `cobblestone`, `crafting_table`. */
  item: z.string().min(1),
  /** Existing block to place against. */
  against: vec3Schema,
  /** Which face of it, as a unit offset such as `{x:0,y:1,z:0}` for the top. */
  face: vec3Schema.refine(isUnitFace, {
    message: 'face must be one of the six unit offsets, e.g. {x:0,y:1,z:0}',
  }),
});
const placeBlockOutput = z.object({
  item: z.string(),
  /** Where the new block ended up: `against` plus `face`. */
  position: vec3Schema,
  /**
   * True when the placement was read back and confirmed. False means the
   * actuator reported success but the space is not currently sensed.
   */
  confirmed: z.boolean(),
});

export type PlaceBlockInput = z.infer<typeof placeBlockInput>;
export type PlaceBlockOutput = z.infer<typeof placeBlockOutput>;

export const placeBlock: Skill<PlaceBlockInput, PlaceBlockOutput> = {
  name: 'placeBlock',
  summary: 'Place a held item against a face of an existing block.',
  description: [
    'Places `item` on the `face` side of the block at `against`, which is how',
    'Minecraft placement actually works: there must be something solid to',
    'build off, and the destination cell must be free.',
    'The precondition checks all three parts: the item is carried, the',
    'supporting block is known and solid, and the destination is known to be',
    'air. A destination the agent cannot sense fails the precondition rather',
    'than placing into fog and overwriting something.',
    'Placement is confirmed by reading the space back afterwards; a supporting',
    'block that changed in the meantime fails `world-changed`.',
    'Do not use this to open a crafting table or chest. Place it once, then',
    'use `craftItem` or the container skills, which find it by name.',
  ].join(' '),
  input: placeBlockInput,
  output: placeBlockOutput,
  precondition: (ctx, input) => {
    if (heldCount(ctx, input.item) < 1) {
      return Promise.resolve(fails(`no ${input.item} in the inventory`));
    }
    const support = ctx.world.blockAt(input.against);
    if (!support) {
      return Promise.resolve(
        fails(
          `nothing is known about the support block at ${show(input.against)}; it is out of sight, not necessarily empty`,
        ),
      );
    }
    if (!support.value.solid || isAirLike(support.value.name)) {
      return Promise.resolve(
        fails(
          `${support.value.name} at ${show(input.against)} is not solid enough to place against`,
        ),
      );
    }
    const destination = add(input.against, input.face);
    const occupant = ctx.world.blockAt(destination);
    if (!occupant) {
      return Promise.resolve(
        fails(
          `nothing is known about the destination ${show(destination)}; sense it before building into it`,
        ),
      );
    }
    if (!isAirLike(occupant.value.name)) {
      return Promise.resolve(
        fails(`${show(destination)} is already occupied by ${occupant.value.name}`),
      );
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<PlaceBlockOutput>(ctx, elapsed, 'before placing');
      if (interrupted) return interrupted;

      const destination = add(input.against, input.face);
      const support = ctx.world.blockAt(input.against);
      if (!support || !support.value.solid || isAirLike(support.value.name)) {
        return fail(
          'world-changed',
          `the support block at ${show(input.against)} is gone${
            support ? ` (it is now ${support.value.name})` : ''
          }`,
          elapsed(),
        );
      }

      const reach = distance(bodyPosition(ctx), blockCentre(destination));
      if (reach > REACH) {
        return fail(
          'unreachable',
          `${show(destination)} is ${reach.toFixed(1)} blocks away, beyond a reach of ${REACH}`,
          elapsed(),
        );
      }

      if (heldCount(ctx, input.item) < 1) {
        return fail('precondition', `no ${input.item} in the inventory`, elapsed());
      }

      await ctx.act.lookAt(blockCentre(destination));
      const outcome = await ctx.act.placeBlock(input.against, input.face, input.item);
      if (!outcome.ok) {
        const stopped = interruptCheck<PlaceBlockOutput>(ctx, elapsed, 'while placing');
        if (stopped) return stopped;
        return fail(
          'unknown',
          `could not place ${input.item} at ${show(destination)}: ${
            outcome.detail ?? 'no detail given'
          }`,
          elapsed(),
        );
      }

      const placed = ctx.world.blockAt(destination);
      if (placed && isAirLike(placed.value.name)) {
        return fail(
          'unknown',
          `placing ${input.item} reported success but ${show(destination)} is still ${placed.value.name}`,
          elapsed(),
        );
      }

      return succeed(
        { item: input.item, position: destination, confirmed: placed !== undefined },
        elapsed(),
      );
    }),
};
