import { describe, expect, it } from 'vitest';
import type { ContainerView } from '../../../src/embodiment/types.js';
import {
  depositItems,
  withdrawItems,
} from '../../../src/skills/library/containers.js';
import { at, block, harness, precondition, refuse } from './harness.js';

const CHEST = at(2, 64, 0);

function chestHolding(contents: readonly { name: string; count: number }[]) {
  return {
    openContainer: (position: {
      x: number;
      y: number;
      z: number;
    }): ContainerView => ({
      kind: 'chest',
      position,
      contents: [...contents],
    }),
  };
}

describe('depositItems', () => {
  it('opens the chest, moves the items, and closes it again', async () => {
    const h = harness({
      inventory: [
        { name: 'cobblestone', count: 20 },
        { name: 'coal', count: 3 },
      ],
      blocks: [block('chest', CHEST)],
    });
    const result = await depositItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'cobblestone', count: 10 }, { name: 'coal' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(13);
    expect(h.world.countItem('cobblestone')).toBe(10);
    expect(h.body.calls).toContain('openContainer');
    expect(h.body.calls.at(-1)).toBe('closeContainer');
  });

  it('refuses a coordinate the agent has never sensed', async () => {
    const h = harness({ inventory: [{ name: 'coal', count: 3 }] });
    const check = await precondition(depositItems, h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('out of sight');
  });

  it('refuses a block that is not a container', async () => {
    const h = harness({
      inventory: [{ name: 'coal', count: 3 }],
      blocks: [block('stone', CHEST)],
    });
    const check = await precondition(depositItems, h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('is not a container');
  });

  it('refuses items that are not carried', async () => {
    const h = harness({ blocks: [block('chest', CHEST)] });
    const check = await precondition(depositItems, h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('no coal');
  });

  it('fails world-changed when the chest has gone by the time we arrive', async () => {
    const h = harness(
      {
        inventory: [{ name: 'coal', count: 3 }],
        blocks: [block('chest', CHEST)],
      },
      { openContainer: () => undefined },
    );
    const result = await depositItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
  });

  it('fails and still closes the chest when nothing fits', async () => {
    const h = harness(
      {
        inventory: [{ name: 'coal', count: 3 }],
        blocks: [block('chest', CHEST)],
      },
      { deposit: () => refuse('the chest is full') },
    );
    const result = await depositItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('probably full');
    expect(h.body.calls).toContain('closeContainer');
  });

  it('fails unreachable when the chest cannot be walked to', async () => {
    const h = harness(
      {
        inventory: [{ name: 'coal', count: 3 }],
        blocks: [block('chest', at(20, 64, 0))],
      },
      { moveTo: () => refuse('walled off') },
    );
    const result = await depositItems.run(h.ctx, {
      position: at(20, 64, 0),
      items: [{ name: 'coal' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(h.body.calls).not.toContain('openContainer');
  });
});

describe('withdrawItems', () => {
  it('takes what was asked for', async () => {
    const h = harness(
      { blocks: [block('chest', CHEST)] },
      chestHolding([{ name: 'iron_ingot', count: 8 }]),
    );
    const result = await withdrawItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'iron_ingot', count: 3 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
    expect(h.world.countItem('iron_ingot')).toBe(3);
    expect(h.body.calls.at(-1)).toBe('closeContainer');
  });

  it('takes what is there when the chest is short, and says so', async () => {
    const h = harness(
      { blocks: [block('barrel', CHEST)] },
      chestHolding([{ name: 'iron_ingot', count: 2 }]),
    );
    const result = await withdrawItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'iron_ingot', count: 10 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0]).toEqual({
      name: 'iron_ingot',
      requested: 10,
      moved: 2,
    });
  });

  it('fails precondition when the chest holds none of it', async () => {
    const h = harness({ blocks: [block('chest', CHEST)] }, chestHolding([]));
    const result = await withdrawItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'iron_ingot', count: 3 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(h.body.calls).toContain('closeContainer');
  });

  it('refuses a container it has never sensed', async () => {
    const h = harness();
    const check = await precondition(withdrawItems, h.ctx, {
      position: CHEST,
      items: [{ name: 'iron_ingot' }],
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('out of sight');
  });

  it('bails when cancelled before opening anything', async () => {
    const h = harness({ blocks: [block('chest', CHEST)] }, chestHolding([]));
    h.controller.abort();
    const result = await withdrawItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'iron_ingot' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(h.body.calls).toHaveLength(0);
  });

  it('accepts a furnace as a container', () => {
    const parsed = withdrawItems.input.safeParse({
      position: CHEST,
      items: [{ name: 'iron_ingot' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('container skills leave nothing open', () => {
  it('closes the container even when a transfer throws', async () => {
    const h = harness(
      {
        inventory: [{ name: 'coal', count: 1 }],
        blocks: [block('chest', CHEST)],
      },
      {
        deposit: () => {
          throw new Error('connection lost');
        },
      },
    );
    const result = await depositItems.run(h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('connection lost');
    expect(h.body.calls).toContain('closeContainer');
    expect(h.world.container).toBeUndefined();
  });

  it('is a no-op on the world when the precondition already fails', async () => {
    const h = harness({ inventory: [{ name: 'coal', count: 1 }] });
    const check = await precondition(depositItems, h.ctx, {
      position: CHEST,
      items: [{ name: 'coal' }],
    });

    expect(check.holds).toBe(false);
    expect(h.body.calls).toHaveLength(0);
  });
});
