import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/sandbox/inventory.js';
import { RecipeBook } from '../../src/sandbox/recipes.js';
import { SymbolicWorld } from '../../src/sandbox/world.js';

describe('SymbolicWorld construction', () => {
  it('defaults to an empty plains world with no stations', () => {
    const world = new SymbolicWorld();
    expect(world.biome).toBe('plains');
    expect(world.inventory.isEmpty).toBe(true);
    expect(world.resources()).toEqual({});
    expect(world.craftingTableInReach).toBe(false);
    expect(world.furnaceInReach).toBe(false);
  });

  it('accepts a record or an Inventory', () => {
    expect(
      new SymbolicWorld({ inventory: { stick: 2 } }).inventory.count('stick'),
    ).toBe(2);
    expect(
      new SymbolicWorld({
        inventory: Inventory.from({ stick: 3 }),
      }).inventory.count('stick'),
    ).toBe(3);
  });

  it('drops depleted deposits from the spec', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 4, sand: 0 } });
    expect(world.resources()).toEqual({ oak_log: 4 });
  });

  it('clones without sharing state', () => {
    const world = new SymbolicWorld({
      resources: { oak_log: 4 },
      biome: 'forest',
      craftingTable: true,
    });
    const copy = world.clone();
    copy.mine('oak_log', 4);
    expect(world.resourceCount('oak_log')).toBe(4);
    expect(copy.resourceCount('oak_log')).toBe(0);
    expect(copy.biome).toBe('forest');
    expect(copy.craftingTableInReach).toBe(true);
  });
});

describe('mine', () => {
  it('moves resource into inventory and depletes the deposit', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 4 } });
    const result = world.mine('oak_log', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gained).toBe(3);
    expect(world.inventory.count('oak_log')).toBe(3);
    expect(world.resourceCount('oak_log')).toBe(1);
  });

  it('refuses a resource that is not nearby', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 4 } });
    const result = world.mine('diamond_ore');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-resource');
    expect(result.message).toContain('plains');
  });

  it('refuses when the deposit is exhausted', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 2 } });
    expect(world.mine('oak_log', 2).ok).toBe(true);
    const again = world.mine('oak_log', 1);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('unknown-resource');
  });

  it('refuses to over-draw a partly depleted deposit, without taking any', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 2 } });
    const result = world.mine('oak_log', 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('resource-exhausted');
    expect(result.shortfall).toEqual({ item: 'oak_log', needed: 5, held: 2 });
    expect(world.inventory.count('oak_log')).toBe(0);
    expect(world.resourceCount('oak_log')).toBe(2);
  });

  it('refuses a nonsense count', () => {
    const world = new SymbolicWorld({ resources: { oak_log: 2 } });
    const result = world.mine('oak_log', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-count');
  });
});

describe('craft', () => {
  it('makes planks from logs in the 2x2 grid, no table needed', () => {
    const world = new SymbolicWorld({ inventory: { oak_log: 2 } });
    const result = world.craft('oak_planks', 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gained).toBe(4);
    expect(result.consumed).toEqual({ oak_log: 1 });
    expect(world.inventory.toRecord()).toEqual({ oak_log: 1, oak_planks: 4 });
  });

  it('keeps the surplus from rounding up to whole crafts', () => {
    const world = new SymbolicWorld({ inventory: { oak_planks: 2 } });
    const result = world.craft('stick', 1);
    expect(result.ok).toBe(true);
    expect(world.inventory.count('stick')).toBe(4);
  });

  it('refuses a recipe that needs a table when none is in reach', () => {
    const world = new SymbolicWorld({
      inventory: { oak_planks: 8, stick: 4 },
      craftingTable: false,
    });
    const result = world.craft('wooden_pickaxe');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-crafting-table');
    expect(world.inventory.count('oak_planks')).toBe(8);
  });

  it('allows the same craft once a table is in reach', () => {
    const world = new SymbolicWorld({
      inventory: { oak_planks: 8, stick: 4 },
      craftingTable: true,
    });
    expect(world.craft('wooden_pickaxe').ok).toBe(true);
    expect(world.inventory.count('wooden_pickaxe')).toBe(1);
  });

  it('lets a task bring a station into reach', () => {
    const world = new SymbolicWorld({ inventory: { oak_planks: 8, stick: 4 } });
    expect(world.craft('wooden_pickaxe').ok).toBe(false);
    world.bringIntoReach('crafting_table');
    expect(world.craft('wooden_pickaxe').ok).toBe(true);
  });

  it('refuses when an ingredient is missing, and says which', () => {
    const world = new SymbolicWorld({
      inventory: { oak_planks: 3 },
      craftingTable: true,
    });
    const result = world.craft('wooden_pickaxe');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-ingredient');
    expect(result.shortfall).toEqual({ item: 'stick', needed: 2, held: 0 });
    expect(world.inventory.count('oak_planks')).toBe(3);
  });

  it('refuses an item nothing crafts', () => {
    const world = new SymbolicWorld();
    const result = world.craft('oak_log');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-recipe');
    expect(result.message).toContain(world.recipes.version);
  });

  it('picks the recipe variant matching the wood in hand', () => {
    const world = new SymbolicWorld({ inventory: { spruce_planks: 2 } });
    const result = world.craft('stick', 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toEqual({ spruce_planks: 2 });
  });

  it('scales ingredients to the requested count', () => {
    const world = new SymbolicWorld({ inventory: { oak_log: 4 } });
    const result = world.craft('oak_planks', 12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toEqual({ oak_log: 3 });
    expect(result.gained).toBe(12);
  });
});

describe('smelt', () => {
  it('smelts raw iron with a furnace in reach', () => {
    const world = new SymbolicWorld({
      inventory: { raw_iron: 3 },
      furnace: true,
    });
    const result = world.smelt('iron_ingot', 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toEqual({ raw_iron: 2 });
    expect(world.inventory.toRecord()).toEqual({ iron_ingot: 2, raw_iron: 1 });
  });

  it('refuses without a furnace', () => {
    const world = new SymbolicWorld({ inventory: { raw_iron: 3 } });
    const result = world.smelt('iron_ingot');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-furnace');
    expect(world.inventory.count('raw_iron')).toBe(3);
  });

  it('accepts any listed input', () => {
    const world = new SymbolicWorld({
      inventory: { deepslate_iron_ore: 2 },
      furnace: true,
    });
    const result = world.smelt('iron_ingot', 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toEqual({ deepslate_iron_ore: 2 });
  });

  it('refuses when no input is in the inventory', () => {
    const world = new SymbolicWorld({ furnace: true });
    const result = world.smelt('iron_ingot');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-ingredient');
    expect(result.message).toContain('raw_iron');
  });

  it('refuses an item nothing smelts', () => {
    const world = new SymbolicWorld({ furnace: true });
    const result = world.smelt('stick');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-recipe');
  });
});

describe('determinism', () => {
  it('two worlds built the same way behave the same way', () => {
    const spec = {
      inventory: { oak_log: 3 },
      resources: { oak_log: 5 },
      craftingTable: true,
      recipes: RecipeBook.forVersion(),
    };
    const a = new SymbolicWorld(spec);
    const b = new SymbolicWorld(spec);
    for (const world of [a, b]) {
      world.mine('oak_log', 2);
      world.craft('oak_planks', 8);
      world.craft('stick', 4);
    }
    expect(a.inventory.toRecord()).toEqual(b.inventory.toRecord());
    expect(a.resources()).toEqual(b.resources());
  });
});
