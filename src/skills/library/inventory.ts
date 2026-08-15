import { z } from 'zod';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import { guarded, heldCount, interruptCheck } from './support.js';

/** Where an item can be worn or held. */
const destinationSchema = z.enum([
  'hand',
  'off-hand',
  'head',
  'torso',
  'legs',
  'feet',
]);

/* ------------------------------------------------------------------ */
/* equipItem                                                           */
/* ------------------------------------------------------------------ */

const equipItemInput = z.object({
  item: z.string().min(1),
  /** Slot to equip into. Defaults to the main hand. */
  destination: destinationSchema.optional(),
});
const equipItemOutput = z.object({
  item: z.string(),
  destination: destinationSchema,
});

export type EquipItemInput = z.infer<typeof equipItemInput>;
export type EquipItemOutput = z.infer<typeof equipItemOutput>;

export const equipItem: Skill<EquipItemInput, EquipItemOutput> = {
  name: 'equipItem',
  summary: 'Hold or wear an item from the inventory.',
  description: [
    'Moves a carried item into the hand, off-hand, or an armour slot.',
    'An item that is not carried fails the precondition: the agent cannot',
    'equip what it does not have, and the remedy is to craft or collect it.',
    'Digging and attacking do not equip for you, so this is worth calling',
    'before either when the right tool matters. Do not use it speculatively',
    'before every action: equipping is a real, ordered change to the body and',
    'shows up in the reliability record.',
  ].join(' '),
  input: equipItemInput,
  output: equipItemOutput,
  precondition: (ctx, input) =>
    Promise.resolve(
      heldCount(ctx, input.item) > 0
        ? HOLDS
        : fails(`no ${input.item} in the inventory`),
    ),
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const destination = input.destination ?? 'hand';
      const interrupted = interruptCheck<EquipItemOutput>(
        ctx,
        elapsed,
        'before equipping',
      );
      if (interrupted) return interrupted;

      if (heldCount(ctx, input.item) < 1) {
        return fail(
          'precondition',
          `no ${input.item} in the inventory`,
          elapsed(),
        );
      }
      const outcome = await ctx.act.equip(input.item, destination);
      if (!outcome.ok) {
        return fail(
          'unknown',
          `could not equip ${input.item} to ${destination}: ${outcome.detail ?? 'no detail given'}`,
          elapsed(),
        );
      }
      return succeed({ item: input.item, destination }, elapsed());
    }),
};

/* ------------------------------------------------------------------ */
/* consumeItem                                                         */
/* ------------------------------------------------------------------ */

const consumeItemInput = z.object({
  item: z.string().min(1),
});
const consumeItemOutput = z.object({
  item: z.string(),
  healthBefore: z.number(),
  healthAfter: z.number(),
  foodBefore: z.number(),
  foodAfter: z.number(),
});

export type ConsumeItemInput = z.infer<typeof consumeItemInput>;
export type ConsumeItemOutput = z.infer<typeof consumeItemOutput>;

export const consumeItem: Skill<ConsumeItemInput, ConsumeItemOutput> = {
  name: 'consumeItem',
  summary: 'Eat or drink a carried item and report the change to the body.',
  description: [
    'Consumes one of a carried item and reports health and food from',
    'proprioception on either side of the act, so the caller can see what it',
    'actually bought rather than assuming a table of nutrition values.',
    'Not carrying the item fails the precondition. A full food bar refuses',
    'most food in Minecraft, which surfaces here as an actuator failure rather',
    'than a silent no-op, so check `foodBefore` before calling.',
    'Do not use this on non-food; the body will simply refuse.',
  ].join(' '),
  input: consumeItemInput,
  output: consumeItemOutput,
  precondition: (ctx, input) =>
    Promise.resolve(
      heldCount(ctx, input.item) > 0
        ? HOLDS
        : fails(`no ${input.item} in the inventory`),
    ),
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<ConsumeItemOutput>(
        ctx,
        elapsed,
        'before consuming',
      );
      if (interrupted) return interrupted;

      if (heldCount(ctx, input.item) < 1) {
        return fail(
          'precondition',
          `no ${input.item} in the inventory`,
          elapsed(),
        );
      }
      const before = ctx.world.body().value;
      const outcome = await ctx.act.consume(input.item);
      if (!outcome.ok) {
        return fail(
          'precondition',
          `could not consume ${input.item}: ${
            outcome.detail ??
            'the body refused it, which usually means a full food bar'
          }`,
          elapsed(),
        );
      }
      const after = ctx.world.body().value;
      return succeed(
        {
          item: input.item,
          healthBefore: before.health,
          healthAfter: after.health,
          foodBefore: before.food,
          foodAfter: after.food,
        },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* dropItem                                                            */
/* ------------------------------------------------------------------ */

const dropItemInput = z.object({
  item: z.string().min(1),
  /** How many to throw. Defaults to the whole stack of that name. */
  count: z.number().int().min(1).max(2304).optional(),
});
const dropItemOutput = z.object({
  item: z.string(),
  requested: z.number().int(),
  /** Measured from the inventory, not taken on the actuator's word. */
  dropped: z.number().int(),
});

export type DropItemInput = z.infer<typeof dropItemInput>;
export type DropItemOutput = z.infer<typeof dropItemOutput>;

export const dropItem: Skill<DropItemInput, DropItemOutput> = {
  name: 'dropItem',
  summary: 'Throw items on the ground.',
  description: [
    'Drops up to `count` of an item and reports how many actually left the',
    'inventory, measured by reading it back.',
    'Asking for more than is carried fails the precondition rather than',
    'quietly dropping fewer, so a plan that depended on the quantity finds out.',
    'Dropped items despawn after five minutes and can be picked up by anyone,',
    'so do not use this to store things; that is `depositItems`. Do not use',
    'it to give an item to a player reliably either; nothing here guarantees',
    'they get it.',
  ].join(' '),
  input: dropItemInput,
  output: dropItemOutput,
  precondition: (ctx, input) => {
    const have = heldCount(ctx, input.item);
    if (have < 1)
      return Promise.resolve(fails(`no ${input.item} in the inventory`));
    if (input.count !== undefined && have < input.count) {
      return Promise.resolve(
        fails(
          `carrying ${have} ${input.item}, short of the ${input.count} requested`,
        ),
      );
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<DropItemOutput>(
        ctx,
        elapsed,
        'before dropping',
      );
      if (interrupted) return interrupted;

      const before = heldCount(ctx, input.item);
      const wanted = input.count ?? before;
      if (before < wanted || wanted < 1) {
        return fail(
          'precondition',
          `carrying ${before} ${input.item}, short of the ${wanted} requested`,
          elapsed(),
        );
      }
      const outcome = await ctx.act.dropItem(input.item, wanted);
      if (!outcome.ok) {
        return fail(
          'unknown',
          `could not drop ${wanted} ${input.item}: ${outcome.detail ?? 'no detail given'}`,
          elapsed(),
        );
      }
      const dropped = before - heldCount(ctx, input.item);
      if (dropped <= 0) {
        return fail(
          'unknown',
          `dropping ${input.item} reported success but the inventory did not change`,
          elapsed(),
        );
      }
      return succeed(
        { item: input.item, requested: wanted, dropped },
        elapsed(),
      );
    }),
};
