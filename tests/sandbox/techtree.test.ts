import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/sandbox/inventory.js';
import { RecipeBook } from '../../src/sandbox/recipes.js';
import { TechTree } from '../../src/sandbox/techtree.js';
import type { PlanStep } from '../../src/sandbox/techtree.js';

const tree = new TechTree();

function names(steps: readonly PlanStep[]): string[] {
  return steps.map((s) => `${s.kind}:${s.item}`);
}

describe('dependencies', () => {
  it('walks the default recipe chain', () => {
    expect(tree.dependencies('oak_planks')).toEqual(['oak_log']);
    expect(tree.dependencies('stick')).toEqual(['oak_log', 'oak_planks']);
    expect(tree.dependencies('wooden_pickaxe')).toEqual([
      'oak_log',
      'oak_planks',
      'stick',
    ]);
  });

  it('excludes the item itself', () => {
    expect(tree.dependencies('iron_ingot')).not.toContain('iron_ingot');
  });

  it('follows smelting as well as crafting', () => {
    expect(tree.dependencies('iron_ingot')).toContain('raw_iron');
  });

  it('unions every variant in `all` mode', () => {
    const all = tree.dependencies('stick', { mode: 'all' });
    expect(all).toContain('birch_planks');
    expect(all).toContain('bamboo');
    expect(tree.dependencies('stick')).not.toContain('birch_planks');
  });

  it('is empty for a raw material', () => {
    expect(tree.dependencies('oak_log')).toEqual([]);
  });

  it('terminates on the real cyclic data in `all` mode', () => {
    // ingot -> block -> ingot and ingot -> nugget -> ingot both exist.
    const deps = tree.dependencies('iron_ingot', { mode: 'all' });
    expect(deps).toContain('iron_block');
    expect(deps).toContain('raw_iron');
  });

  it('sees that iron is genuinely self-referential', () => {
    expect(tree.isCyclic('iron_ingot')).toBe(true);
    expect(tree.isCyclic('oak_planks')).toBe(false);
  });
});

describe('craftingPlan: the wood chain', () => {
  it('orders log -> planks -> sticks -> pickaxe', () => {
    const plan = tree.craftingPlan(
      'wooden_pickaxe',
      1,
      Inventory.from({ oak_log: 4 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toEqual([
      'craft:oak_planks',
      'craft:stick',
      'craft:wooden_pickaxe',
    ]);
    expect(plan.requiresCraftingTable).toBe(true);
    expect(plan.requiresFurnace).toBe(false);
  });

  it('buys enough planks for both the head and the handle', () => {
    const plan = tree.craftingPlan(
      'wooden_pickaxe',
      1,
      Inventory.from({ oak_log: 4 }),
    );
    if (!plan.ok) throw new Error('expected a plan');
    const planks = plan.steps.find((s) => s.item === 'oak_planks');
    // 3 planks for the head plus 2 for the sticks: two crafts, eight planks.
    expect(planks?.times).toBe(2);
    expect(planks?.produces).toBe(8);
    expect(planks?.consumes).toEqual([{ item: 'oak_log', count: 2 }]);
  });

  it('merges the two plank crafts into one step', () => {
    const plan = tree.craftingPlan(
      'wooden_pickaxe',
      1,
      Inventory.from({ oak_log: 4 }),
    );
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.steps.filter((s) => s.item === 'oak_planks')).toHaveLength(1);
  });

  it('leaves the target and the surplus in the resulting inventory', () => {
    const plan = tree.craftingPlan(
      'wooden_pickaxe',
      1,
      Inventory.from({ oak_log: 4 }),
    );
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.resulting.count('wooden_pickaxe')).toBe(1);
    expect(plan.resulting.count('oak_log')).toBe(2);
    expect(plan.resulting.count('oak_planks')).toBe(3);
    expect(plan.resulting.count('stick')).toBe(2);
  });

  it('does nothing when the inventory already satisfies the goal', () => {
    const plan = tree.craftingPlan('stick', 2, Inventory.from({ stick: 8 }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([]);
  });

  it('uses whatever wood is actually in hand', () => {
    const plan = tree.craftingPlan(
      'stick',
      4,
      Inventory.from({ birch_planks: 2 }),
    );
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.steps[0]?.consumes).toEqual([
      { item: 'birch_planks', count: 2 },
    ]);
  });

  it('scales with the requested count', () => {
    const plan = tree.craftingPlan('stick', 16, Inventory.from({ oak_log: 8 }));
    if (!plan.ok) throw new Error('expected a plan');
    const sticks = plan.steps.find((s) => s.item === 'stick');
    expect(sticks?.times).toBe(4);
    expect(sticks?.produces).toBe(16);
  });
});

describe('craftingPlan: smelting', () => {
  it('plans a smelt when the ore is in hand', () => {
    const plan = tree.craftingPlan(
      'iron_ingot',
      3,
      Inventory.from({ raw_iron: 3 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toEqual(['smelt:iron_ingot']);
    expect(plan.requiresFurnace).toBe(true);
    expect(plan.steps[0]?.consumes).toEqual([{ item: 'raw_iron', count: 3 }]);
  });

  it('chains a smelt into a craft', () => {
    const plan = tree.craftingPlan(
      'iron_pickaxe',
      1,
      Inventory.from({ raw_iron: 3, oak_log: 4 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toContain('smelt:iron_ingot');
    expect(names(plan.steps).at(-1)).toBe('craft:iron_pickaxe');
    expect(plan.requiresFurnace).toBe(true);
  });

  it('prefers a shortfall the world can actually supply', () => {
    const withRaw = tree.craftingPlan('iron_ingot', 1, Inventory.empty(), {
      gatherable: ['raw_iron'],
    });
    expect(withRaw.ok).toBe(false);
    if (withRaw.ok || withRaw.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(withRaw.missing).toEqual([{ item: 'raw_iron', count: 1 }]);
  });
});

describe('craftingPlan: what is missing', () => {
  it('names the raw material to gather', () => {
    const plan = tree.craftingPlan('wooden_pickaxe', 1, Inventory.empty(), {
      gatherable: ['oak_log'],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(plan.missing).toEqual([{ item: 'oak_log', count: 2 }]);
    // The plan those logs would unlock still comes back.
    expect(names(plan.steps)).toEqual([
      'craft:oak_planks',
      'craft:stick',
      'craft:wooden_pickaxe',
    ]);
  });

  it('counts only the shortfall, not the whole requirement', () => {
    const plan = tree.craftingPlan(
      'wooden_pickaxe',
      1,
      Inventory.from({ oak_log: 1 }),
      { gatherable: ['oak_log'] },
    );
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(plan.missing).toEqual([{ item: 'oak_log', count: 1 }]);
  });

  it('reports several gaps at once instead of one per run', () => {
    const plan = tree.craftingPlan('iron_pickaxe', 1, Inventory.empty(), {
      gatherable: ['oak_log', 'raw_iron'],
    });
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(plan.missing.map((m) => m.item)).toEqual(['oak_log', 'raw_iron']);
  });

  it('rejects an item the pinned version has never heard of', () => {
    const plan = tree.craftingPlan('unobtainium', 1);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('unknown-item');
  });

  it('refuses a non-positive count', () => {
    expect(() => tree.craftingPlan('stick', 0)).toThrow(RangeError);
  });
});

describe('craftingPlan: cycle guarding', () => {
  it('terminates on the ingot/block cycle in real data', () => {
    const plan = tree.craftingPlan('iron_ingot', 1, Inventory.empty());
    expect(plan.ok).toBe(false);
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    // Not "you need an iron block", which would need nine ingots to make.
    expect(plan.missing.map((m) => m.item)).not.toContain('iron_block');
  });

  it('unpacks a block into ingots when the block is what you have', () => {
    const plan = tree.craftingPlan(
      'iron_ingot',
      9,
      Inventory.from({ iron_block: 1 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toEqual(['craft:iron_ingot']);
  });

  it('packs ingots into a block when the block is what you want', () => {
    const plan = tree.craftingPlan(
      'iron_block',
      1,
      Inventory.from({ iron_ingot: 9 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toEqual(['craft:iron_block']);
  });

  it('terminates on a two-item cycle with no exit', () => {
    const book = RecipeBook.fromTables({
      crafting: [
        { result: 'alpha', ingredients: [{ item: 'beta', count: 1 }] },
        { result: 'beta', ingredients: [{ item: 'alpha', count: 1 }] },
      ],
    });
    const plan = new TechTree(book).craftingPlan('alpha', 1);
    expect(plan.ok).toBe(false);
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(plan.missing).toEqual([{ item: 'alpha', count: 1 }]);
  });

  it('terminates on a recipe that names itself', () => {
    const book = RecipeBook.fromTables({
      crafting: [
        {
          result: 'ouroboros',
          resultCount: 2,
          ingredients: [{ item: 'ouroboros', count: 1 }],
        },
      ],
    });
    const plan = new TechTree(book).craftingPlan('ouroboros', 1);
    expect(plan.ok).toBe(false);
    if (plan.ok || plan.reason !== 'missing-materials') {
      throw new Error('expected missing materials');
    }
    expect(plan.missing).toEqual([{ item: 'ouroboros', count: 1 }]);
  });

  it('escapes a cycle when one branch reaches raw material', () => {
    const book = RecipeBook.fromTables({
      crafting: [
        { result: 'alpha', ingredients: [{ item: 'beta', count: 1 }] },
        { result: 'beta', ingredients: [{ item: 'alpha', count: 1 }] },
        { result: 'alpha', ingredients: [{ item: 'dust', count: 2 }] },
      ],
      items: ['dust'],
    });
    const plan = new TechTree(book).craftingPlan(
      'alpha',
      1,
      Inventory.from({ dust: 2 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(names(plan.steps)).toEqual(['craft:alpha']);
  });

  it('dependencies terminate on a two-item cycle', () => {
    const book = RecipeBook.fromTables({
      crafting: [
        { result: 'alpha', ingredients: [{ item: 'beta', count: 1 }] },
        { result: 'beta', ingredients: [{ item: 'alpha', count: 1 }] },
      ],
    });
    const cyclic = new TechTree(book);
    expect(cyclic.dependencies('alpha')).toEqual(['beta']);
    expect(cyclic.isCyclic('alpha')).toBe(true);
  });

  it('gives up rather than hanging when the search budget is tiny', () => {
    const plan = tree.craftingPlan('iron_pickaxe', 64, Inventory.empty(), {
      maxNodes: 5,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('search-exhausted');
  });

  it('stays inside its node budget on a deep real target', () => {
    const start = Date.now();
    const plan = tree.craftingPlan(
      'diamond_pickaxe',
      1,
      Inventory.from({ oak_log: 8, diamond: 3 }),
    );
    expect(plan.ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
