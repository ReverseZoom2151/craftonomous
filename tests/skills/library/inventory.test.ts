import { describe, expect, it } from 'vitest';
import {
  consumeItem,
  dropItem,
  equipItem,
} from '../../../src/skills/library/inventory.js';
import { OK, at, block, harness, precondition, refuse } from './harness.js';

describe('equipItem', () => {
  it('equips a carried item, defaulting to the hand', async () => {
    const h = harness({ inventory: [{ name: 'iron_pickaxe', count: 1 }] });
    const result = await equipItem.run(h.ctx, { item: 'iron_pickaxe' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destination).toBe('hand');
    expect(h.body.calls).toEqual(['equip']);
  });

  it('equips armour to the slot asked for', async () => {
    const h = harness({ inventory: [{ name: 'iron_helmet', count: 1 }] });
    const result = await equipItem.run(h.ctx, {
      item: 'iron_helmet',
      destination: 'head',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destination).toBe('head');
  });

  it('fails its precondition for an item that is not carried', async () => {
    const h = harness();
    const check = await precondition(equipItem, h.ctx, {
      item: 'iron_pickaxe',
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('no iron_pickaxe');
  });

  it('reports an actuator refusal', async () => {
    const h = harness(
      { inventory: [{ name: 'stone', count: 1 }] },
      { equip: () => refuse('stone is not armour') },
    );
    const result = await equipItem.run(h.ctx, {
      item: 'stone',
      destination: 'head',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not armour');
  });
});

describe('consumeItem', () => {
  it('reports the body on both sides of eating', async () => {
    const h = harness(
      { body: { food: 12 }, inventory: [{ name: 'bread', count: 2 }] },
      {
        consume: (item) => {
          h.world.take(item, 1);
          h.world.body_ = { ...h.world.body_, food: 17 };
          return OK;
        },
      },
    );
    const result = await consumeItem.run(h.ctx, { item: 'bread' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.foodBefore).toBe(12);
    expect(result.value.foodAfter).toBe(17);
    expect(h.world.countItem('bread')).toBe(1);
  });

  it('fails its precondition for food that is not carried', async () => {
    const h = harness();
    const check = await precondition(consumeItem, h.ctx, { item: 'bread' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('no bread');
  });

  it('surfaces a refusal on a full food bar as a precondition failure', async () => {
    const h = harness(
      { body: { food: 20 }, inventory: [{ name: 'bread', count: 1 }] },
      { consume: () => refuse('food bar is full') },
    );
    const result = await consumeItem.run(h.ctx, { item: 'bread' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(result.message).toContain('full');
  });
});

describe('dropItem', () => {
  it('drops the whole stack by default and counts what left', async () => {
    const h = harness({ inventory: [{ name: 'cobblestone', count: 12 }] });
    const result = await dropItem.run(h.ctx, { item: 'cobblestone' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped).toBe(12);
    expect(h.world.countItem('cobblestone')).toBe(0);
  });

  it('drops a requested count', async () => {
    const h = harness({ inventory: [{ name: 'cobblestone', count: 12 }] });
    const result = await dropItem.run(h.ctx, { item: 'cobblestone', count: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dropped).toBe(5);
    expect(h.world.countItem('cobblestone')).toBe(7);
  });

  it('fails its precondition rather than dropping fewer than asked', async () => {
    const h = harness({ inventory: [{ name: 'cobblestone', count: 2 }] });
    const check = await precondition(dropItem, h.ctx, {
      item: 'cobblestone',
      count: 5,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('short of the 5');
  });

  it('does not believe a drop that changed nothing', async () => {
    const h = harness(
      { inventory: [{ name: 'cobblestone', count: 2 }] },
      { dropItem: () => OK },
    );
    const result = await dropItem.run(h.ctx, { item: 'cobblestone' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
  });

  it('bails when the caller has already cancelled', async () => {
    const h = harness({ inventory: [{ name: 'cobblestone', count: 2 }] });
    h.controller.abort();
    const result = await dropItem.run(h.ctx, { item: 'cobblestone' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
  });
});

describe('inventory skills only read through the world view', () => {
  it('sees an item the world does not report as absent', async () => {
    // A stack that exists on the server but not in what the view returns is,
    // for the skill, simply not there.
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const check = await precondition(dropItem, h.ctx, { item: 'diamond' });

    expect(check.holds).toBe(false);
    expect(h.world.reads).toContain('inventory');
  });
});
