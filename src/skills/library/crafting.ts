import { z } from 'zod';
import { blockCentre, distance } from '../../embodiment/geometry.js';
import type { ItemStack } from '../../embodiment/types.js';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  bodyPosition,
  countOf,
  guarded,
  heldCount,
  interruptCheck,
  moveWithin,
  nearestBlock,
  show,
  sleep,
  vec3Schema,
} from './support.js';

/** Blocks that smelt. Any of them satisfies `smeltItem`. */
const FURNACES = ['furnace', 'blast_furnace', 'smoker'] as const;

/* ------------------------------------------------------------------ */
/* craftItem                                                           */
/* ------------------------------------------------------------------ */

const craftItemInput = z.object({
  /** The item to produce, e.g. `stick`, `wooden_pickaxe`. */
  item: z.string().min(1),
  /** How many to produce. One craft may yield several; this is the target. */
  count: z.number().int().min(1).max(64).optional(),
  /**
   * `true` requires a nearby crafting table and fails without one; `false`
   * forbids using one, restricting the craft to the 2x2 grid; omitted uses a
   * table when one is known nearby.
   */
  useCraftingTable: z.boolean().optional(),
  /** How far to look for a table. Defaults to 8. */
  maxDistance: z.number().min(1).max(64).optional(),
});
const craftItemOutput = z.object({
  item: z.string(),
  requested: z.number().int(),
  /** Net increase of `item` in the inventory. May exceed `requested`. */
  crafted: z.number().int(),
  usedCraftingTable: z.boolean(),
  tablePosition: vec3Schema.optional(),
});

export type CraftItemInput = z.infer<typeof craftItemInput>;
export type CraftItemOutput = z.infer<typeof craftItemOutput>;

export const craftItem: Skill<CraftItemInput, CraftItemOutput> = {
  name: 'craftItem',
  summary: 'Craft an item, using a nearby crafting table when one is needed.',
  description: [
    'Crafts up to `count` of an item. When a crafting table is known within',
    '`maxDistance`, the agent walks to it and crafts against it, which unlocks',
    'the 3x3 recipes; otherwise it uses the 2x2 inventory grid.',
    'Success is measured as the net gain of `item` in the inventory, not the',
    "actuator's say-so, so a call that reports success while producing nothing",
    'fails instead of quietly lying.',
    'Missing ingredients fail `precondition`: the remedy is to gather, not to',
    'retry. Requesting a table that is not known fails the precondition too;',
    'place one first with `placeBlock`.',
    'Do not use this for smelting: furnaces are `smeltItem`.',
  ].join(' '),
  input: craftItemInput,
  output: craftItemOutput,
  precondition: (ctx, input) => {
    if (input.useCraftingTable !== true) return Promise.resolve(HOLDS);
    const maxDistance = input.maxDistance ?? 8;
    const table = nearestBlock(ctx, ['crafting_table'], maxDistance);
    return Promise.resolve(
      table
        ? HOLDS
        : fails(
            `a crafting table was required but none is known within ${maxDistance} blocks`,
          ),
    );
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const wanted = input.count ?? 1;
      const maxDistance = input.maxDistance ?? 8;
      const interrupted = interruptCheck<CraftItemOutput>(
        ctx,
        elapsed,
        'before crafting',
      );
      if (interrupted) return interrupted;

      const table =
        input.useCraftingTable === false
          ? undefined
          : nearestBlock(ctx, ['crafting_table'], maxDistance);
      if (input.useCraftingTable === true && !table) {
        return fail(
          'world-changed',
          `the crafting table within ${maxDistance} blocks is no longer known`,
          elapsed(),
        );
      }

      if (table) {
        const centre = blockCentre(table.value.position);
        if (distance(bodyPosition(ctx), centre) > 3) {
          const moved = await moveWithin(ctx, centre, 3);
          if (!moved.ok) {
            const stopped = interruptCheck<CraftItemOutput>(
              ctx,
              elapsed,
              'while approaching the table',
            );
            if (stopped) return stopped;
            return fail(
              'unreachable',
              `could not reach the crafting table at ${show(table.value.position)}: ${moved.detail}`,
              elapsed(),
            );
          }
        }
      }

      const before = heldCount(ctx, input.item);
      const outcome = await ctx.act.craft(
        input.item,
        wanted,
        table ? { craftingTable: table.value.position } : undefined,
      );
      if (!outcome.ok) {
        const stopped = interruptCheck<CraftItemOutput>(
          ctx,
          elapsed,
          'while crafting',
        );
        if (stopped) return stopped;
        return fail(
          'precondition',
          `cannot craft ${wanted} ${input.item}${table ? ' at the table' : ' without a table'}: ${
            outcome.detail ?? 'the recipe or its ingredients were unavailable'
          }`,
          elapsed(),
        );
      }

      const crafted = heldCount(ctx, input.item) - before;
      if (crafted <= 0) {
        return fail(
          'unknown',
          `crafting ${input.item} reported success but the inventory did not change`,
          elapsed(),
        );
      }

      return succeed(
        {
          item: input.item,
          requested: wanted,
          crafted,
          usedCraftingTable: table !== undefined,
          ...(table ? { tablePosition: table.value.position } : {}),
        },
        elapsed(),
      );
    }),
};

/* ------------------------------------------------------------------ */
/* smeltItem                                                           */
/* ------------------------------------------------------------------ */

const smeltItemInput = z.object({
  /** What to put in the input slot, e.g. `raw_iron`. */
  item: z.string().min(1),
  /** How many to smelt. Defaults to 1. */
  count: z.number().int().min(1).max(64).optional(),
  /** Fuel to add, e.g. `coal`. Omit when the furnace is already burning. */
  fuel: z.string().min(1).optional(),
  /** Expected product, e.g. `iron_ingot`. Omit to accept whatever appears. */
  output: z.string().min(1).optional(),
  /** How far to look for a furnace. Defaults to 8. */
  maxDistance: z.number().min(1).max(64).optional(),
  /** How long to wait for the burn. Defaults to 20 000 ms. */
  maxWaitMs: z.number().int().min(0).max(600_000).optional(),
  /** How often to check the furnace. Defaults to 500 ms. */
  pollIntervalMs: z.number().int().min(0).max(10_000).optional(),
});
const smeltItemOutput = z.object({
  item: z.string(),
  requested: z.number().int(),
  /** Product taken out of the furnace, when anything was produced. */
  output: z.string().optional(),
  smelted: z.number().int(),
  furnacePosition: vec3Schema,
  /** True when the wait ran out with fewer than `requested` produced. */
  timedOut: z.boolean(),
});

export type SmeltItemInput = z.infer<typeof smeltItemInput>;
export type SmeltItemOutput = z.infer<typeof smeltItemOutput>;

/** Anything in the furnace that is neither the input nor the fuel is product. */
function product(
  contents: readonly ItemStack[],
  input: string,
  fuel: string | undefined,
  expected: string | undefined,
): { readonly name: string; readonly count: number } | undefined {
  let best: { name: string; count: number } | undefined;
  for (const stack of contents) {
    if (expected !== undefined) {
      if (stack.name !== expected) continue;
    } else if (stack.name === input || stack.name === fuel) {
      continue;
    }
    const count = countOf(contents, stack.name);
    if (!best || count > best.count) best = { name: stack.name, count };
  }
  return best;
}

export const smeltItem: Skill<SmeltItemInput, SmeltItemOutput> = {
  name: 'smeltItem',
  summary: 'Smelt items in a nearby furnace and take the product back out.',
  description: [
    'Walks to the nearest known furnace, blast furnace or smoker, loads fuel',
    'and input, waits for the burn, and withdraws whatever appears in the',
    'output slot.',
    'The furnace must already be known: none nearby fails the precondition,',
    'and the remedy is to place one. The input must already be carried.',
    'Burning takes real server time, so this skill polls and can return a',
    'partial result with `timedOut` set; producing nothing at all within the',
    'wait fails `timeout`, usually meaning the furnace had no fuel.',
    'Do not use this for recipes that need a grid; that is `craftItem`.',
  ].join(' '),
  input: smeltItemInput,
  output: smeltItemOutput,
  precondition: (ctx, input) => {
    const maxDistance = input.maxDistance ?? 8;
    const furnace = nearestBlock(ctx, FURNACES, maxDistance);
    if (!furnace) {
      return Promise.resolve(
        fails(`no furnace is known within ${maxDistance} blocks`),
      );
    }
    const wanted = input.count ?? 1;
    const have = heldCount(ctx, input.item);
    if (have < wanted) {
      return Promise.resolve(
        fails(
          `carrying ${have} ${input.item}, which is short of the ${wanted} requested`,
        ),
      );
    }
    if (input.fuel !== undefined && heldCount(ctx, input.fuel) < 1) {
      return Promise.resolve(fails(`no ${input.fuel} to burn`));
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const wanted = input.count ?? 1;
      const maxDistance = input.maxDistance ?? 8;
      const maxWaitMs = input.maxWaitMs ?? 20_000;
      const interval = input.pollIntervalMs ?? 500;
      const interrupted = interruptCheck<SmeltItemOutput>(
        ctx,
        elapsed,
        'before smelting',
      );
      if (interrupted) return interrupted;

      const furnace = nearestBlock(ctx, FURNACES, maxDistance);
      if (!furnace) {
        return fail(
          'world-changed',
          `the furnace within ${maxDistance} blocks is no longer known`,
          elapsed(),
        );
      }
      const at = furnace.value.position;
      const centre = blockCentre(at);

      if (distance(bodyPosition(ctx), centre) > 3) {
        const moved = await moveWithin(ctx, centre, 3);
        if (!moved.ok) {
          const stopped = interruptCheck<SmeltItemOutput>(
            ctx,
            elapsed,
            'while approaching the furnace',
          );
          if (stopped) return stopped;
          return fail(
            'unreachable',
            `could not reach the furnace at ${show(at)}: ${moved.detail}`,
            elapsed(),
          );
        }
      }

      const opened = await ctx.act.openContainer(at);
      if (!opened) {
        return fail(
          'world-changed',
          `nothing opens at ${show(at)} any more`,
          elapsed(),
        );
      }

      try {
        if (input.fuel !== undefined) {
          const fuelled = await ctx.act.deposit(input.fuel, 1);
          if (!fuelled.ok) {
            return fail(
              'precondition',
              `could not load ${input.fuel} as fuel: ${fuelled.detail ?? 'no detail given'}`,
              elapsed(),
            );
          }
        }
        const loaded = await ctx.act.deposit(input.item, wanted);
        if (!loaded.ok) {
          return fail(
            'precondition',
            `could not load ${wanted} ${input.item}: ${loaded.detail ?? 'no detail given'}`,
            elapsed(),
          );
        }

        // Burning happens on the server's clock, so poll rather than assume.
        const maxPolls = Math.ceil(maxWaitMs / Math.max(1, interval)) + 1;
        let made: { readonly name: string; readonly count: number } | undefined;
        for (let poll = 0; poll < maxPolls; poll += 1) {
          const stopped = interruptCheck<SmeltItemOutput>(
            ctx,
            elapsed,
            'while the furnace burned',
          );
          if (stopped) return stopped;

          const view = ctx.world.openContainer();
          if (!view) {
            return fail(
              'world-changed',
              `the furnace at ${show(at)} closed unexpectedly`,
              elapsed(),
            );
          }
          made = product(
            view.value.contents,
            input.item,
            input.fuel,
            input.output,
          );
          if (made && made.count >= wanted) break;
          if (elapsed() >= maxWaitMs) break;
          await sleep(interval);
        }

        if (!made || made.count === 0) {
          return fail(
            'timeout',
            `nothing came out of the furnace at ${show(at)} within ${maxWaitMs}ms; it may have no fuel`,
            elapsed(),
          );
        }

        const taken = await ctx.act.withdraw(made.name, made.count);
        if (!taken.ok) {
          return fail(
            'unknown',
            `could not take ${made.count} ${made.name} out of the furnace: ${
              taken.detail ?? 'no detail given'
            }`,
            elapsed(),
          );
        }

        return succeed(
          {
            item: input.item,
            requested: wanted,
            output: made.name,
            smelted: made.count,
            furnacePosition: at,
            timedOut: made.count < wanted,
          },
          elapsed(),
        );
      } finally {
        await ctx.act.closeContainer();
      }
    }),
};
