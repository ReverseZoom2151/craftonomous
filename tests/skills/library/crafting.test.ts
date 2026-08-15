import { describe, expect, it } from 'vitest';
import type { ContainerView } from '../../../src/embodiment/types.js';
import { craftItem, smeltItem } from '../../../src/skills/library/crafting.js';
import { OK, at, block, harness, precondition, refuse } from './harness.js';

describe('craftItem', () => {
  it('crafts on the inventory grid when no table is known', async () => {
    const h = harness({ inventory: [{ name: 'oak_planks', count: 8 }] });
    const result = await craftItem.run(h.ctx, { item: 'stick', count: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usedCraftingTable).toBe(false);
    expect(result.value.crafted).toBe(4);
    expect(h.body.calls).not.toContain('moveTo');
  });

  it('walks to a known crafting table and crafts against it', async () => {
    const h = harness({
      inventory: [{ name: 'oak_planks', count: 8 }],
      blocks: [block('crafting_table', at(6, 64, 0))],
    });
    const result = await craftItem.run(h.ctx, { item: 'wooden_pickaxe' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usedCraftingTable).toBe(true);
    expect(result.value.tablePosition).toEqual(at(6, 64, 0));
    expect(h.body.calls).toContain('moveTo');
  });

  it('honours a caller who forbids the table', async () => {
    const h = harness({
      inventory: [{ name: 'oak_planks', count: 8 }],
      blocks: [block('crafting_table', at(2, 64, 0))],
    });
    const result = await craftItem.run(h.ctx, {
      item: 'stick',
      useCraftingTable: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usedCraftingTable).toBe(false);
  });

  it('fails its precondition when a required table has not been sensed', async () => {
    const h = harness({ inventory: [{ name: 'oak_planks', count: 8 }] });
    const check = await precondition(craftItem, h.ctx, {
      item: 'chest',
      useCraftingTable: true,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('none is known');
  });

  it('fails unreachable when the table cannot be walked to', async () => {
    const h = harness(
      {
        inventory: [{ name: 'oak_planks', count: 8 }],
        blocks: [block('crafting_table', at(6, 64, 0))],
      },
      { moveTo: () => refuse('fenced in') },
    );
    const result = await craftItem.run(h.ctx, { item: 'chest' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
  });

  it('reads missing ingredients as a precondition failure', async () => {
    const h = harness({}, { craft: () => refuse('missing 3 oak_planks') });
    const result = await craftItem.run(h.ctx, { item: 'stick' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('missing 3 oak_planks');
  });

  it('does not believe a craft that produced nothing', async () => {
    const h = harness(
      { inventory: [{ name: 'oak_planks', count: 8 }] },
      { craft: () => OK },
    );
    const result = await craftItem.run(h.ctx, { item: 'stick' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('inventory did not change');
  });
});

/** A furnace that turns whatever is loaded into ingots the moment it is fed. */
function instantFurnace(
  position = at(2, 64, 0),
  output = 'iron_ingot',
  yield_ = 2,
) {
  const h = harness(
    {
      inventory: [
        { name: 'raw_iron', count: 3 },
        { name: 'coal', count: 2 },
      ],
      blocks: [block('furnace', position)],
    },
    {
      openContainer: (p): ContainerView => ({
        kind: 'furnace',
        position: p,
        contents: [],
      }),
      deposit: (item, count) => {
        h.world.take(item, count);
        const view = h.world.container;
        if (!view) return refuse('no container open');
        if (item === 'raw_iron') {
          h.world.setContainerContents([
            ...view.contents,
            { name: output, count: yield_ },
          ]);
        } else {
          h.world.setContainerContents([
            ...view.contents,
            { name: item, count },
          ]);
        }
        return OK;
      },
    },
  );
  return h;
}

describe('smeltItem', () => {
  it('loads the furnace, waits, and takes the product out', async () => {
    const h = instantFurnace();
    const result = await smeltItem.run(h.ctx, {
      item: 'raw_iron',
      count: 2,
      fuel: 'coal',
      maxWaitMs: 5,
      pollIntervalMs: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe('iron_ingot');
    expect(result.value.smelted).toBe(2);
    expect(result.value.timedOut).toBe(false);
    expect(h.world.countItem('iron_ingot')).toBe(2);
    expect(h.body.calls).toContain('closeContainer');
  });

  it('returns a partial burn with timedOut set', async () => {
    const h = instantFurnace(at(2, 64, 0), 'iron_ingot', 1);
    const result = await smeltItem.run(h.ctx, {
      item: 'raw_iron',
      count: 3,
      fuel: 'coal',
      maxWaitMs: 5,
      pollIntervalMs: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.smelted).toBe(1);
    expect(result.value.timedOut).toBe(true);
  });

  it('fails timeout when nothing comes out, and still closes the furnace', async () => {
    const h = harness(
      {
        inventory: [{ name: 'raw_iron', count: 2 }],
        blocks: [block('furnace', at(2, 64, 0))],
      },
      {
        openContainer: (p): ContainerView => ({
          kind: 'furnace',
          position: p,
          contents: [],
        }),
      },
    );
    const result = await smeltItem.run(h.ctx, {
      item: 'raw_iron',
      count: 1,
      maxWaitMs: 5,
      pollIntervalMs: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.message).toContain('no fuel');
    expect(h.body.calls).toContain('closeContainer');
  });

  it('fails its precondition when no furnace has been sensed', async () => {
    const h = harness({ inventory: [{ name: 'raw_iron', count: 2 }] });
    const check = await precondition(smeltItem, h.ctx, { item: 'raw_iron' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('no furnace is known');
  });

  it('fails its precondition when the input is not carried', async () => {
    const h = harness({ blocks: [block('furnace', at(2, 64, 0))] });
    const check = await precondition(smeltItem, h.ctx, {
      item: 'raw_iron',
      count: 2,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('short of the 2');
  });

  it('fails world-changed when the furnace will not open', async () => {
    const h = harness(
      {
        inventory: [{ name: 'raw_iron', count: 2 }],
        blocks: [block('furnace', at(2, 64, 0))],
      },
      { openContainer: () => undefined },
    );
    const result = await smeltItem.run(h.ctx, {
      item: 'raw_iron',
      maxWaitMs: 5,
      pollIntervalMs: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
  });
});
