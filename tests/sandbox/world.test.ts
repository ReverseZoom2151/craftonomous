import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/sandbox/inventory.js';
import { RecipeBook } from '../../src/sandbox/recipes.js';
import { DEFAULT_AGENT_POSITION } from '../../src/sandbox/space.js';
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

describe('space defaults', () => {
  it('a world with no spatial setup stands somewhere empty', () => {
    const world = new SymbolicWorld();
    expect(world.agentPosition).toEqual(DEFAULT_AGENT_POSITION);
    expect(world.blocks()).toEqual([]);
    expect(world.blockAt({ x: 0, y: 64, z: 0 })).toBeUndefined();
    expect(world.enclosed).toBe(false);
    expect(world.openFaces()).toHaveLength(6);
  });

  it('accepts a starting position and starting blocks', () => {
    const world = new SymbolicWorld({
      agent: { x: 10, y: 70, z: -3 },
      blocks: [{ position: { x: 10, y: 69, z: -3 }, name: 'cobblestone' }],
    });
    expect(world.agentPosition).toEqual({ x: 10, y: 70, z: -3 });
    expect(world.blockAt({ x: 10, y: 69, z: -3 })?.name).toBe('cobblestone');
    expect(world.openFaces()).toHaveLength(5);
  });

  it('refuses a fractional starting position', () => {
    expect(() => new SymbolicWorld({ agent: { x: 0.5, y: 64, z: 0 } })).toThrow(
      RangeError,
    );
  });

  it('clones the spatial state without sharing it', () => {
    const world = new SymbolicWorld({
      inventory: { cobblestone: 4 },
      agent: { x: 0, y: 64, z: 0 },
    });
    const copy = world.clone();
    copy.place('cobblestone', { x: 1, y: 64, z: 0 });
    copy.move({ x: 0, y: 65, z: 0 });
    expect(world.blocks()).toEqual([]);
    expect(world.agentPosition).toEqual({ x: 0, y: 64, z: 0 });
    expect(copy.blocks()).toHaveLength(1);
    expect(copy.agentPosition).toEqual({ x: 0, y: 65, z: 0 });
  });
});

describe('place', () => {
  const held = (): SymbolicWorld =>
    new SymbolicWorld({
      inventory: { cobblestone: 2, crafting_table: 1 },
      agent: { x: 0, y: 64, z: 0 },
    });

  it('puts a held block down and spends it', () => {
    const world = held();
    const result = world.place('cobblestone', { x: 1, y: 64, z: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toEqual({ cobblestone: 1 });
    expect(result.position).toEqual({ x: 1, y: 64, z: 0 });
    expect(world.inventory.count('cobblestone')).toBe(1);
    expect(world.blockAt({ x: 1, y: 64, z: 0 })?.name).toBe('cobblestone');
  });

  it('refuses a block the inventory does not hold', () => {
    const world = held();
    const result = world.place('dirt', { x: 1, y: 64, z: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('item-not-held');
    expect(result.shortfall).toEqual({ item: 'dirt', needed: 1, held: 0 });
    expect(world.blocks()).toEqual([]);
  });

  it("refuses an occupied position, including the agent's own cell", () => {
    const world = held();
    expect(world.place('cobblestone', { x: 1, y: 64, z: 0 }).ok).toBe(true);
    const again = world.place('cobblestone', { x: 1, y: 64, z: 0 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('position-occupied');

    const onSelf = world.place('cobblestone', { x: 0, y: 64, z: 0 });
    expect(onSelf.ok).toBe(false);
    if (onSelf.ok) return;
    expect(onSelf.reason).toBe('position-occupied');
    expect(world.inventory.count('cobblestone')).toBe(1);
  });

  it('refuses a position beyond reach', () => {
    const world = held();
    const result = world.place('cobblestone', { x: 20, y: 64, z: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-reach');
  });

  it('refuses a fractional position and one above the build limit', () => {
    const world = held();
    const fractional = world.place('cobblestone', { x: 0.5, y: 64, z: 0 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.reason).toBe('invalid-position');

    const sky = new SymbolicWorld({
      inventory: { cobblestone: 1 },
      agent: { x: 0, y: 319, z: 0 },
    }).place('cobblestone', { x: 0, y: 320, z: 0 });
    expect(sky.ok).toBe(false);
    if (sky.ok) return;
    expect(sky.reason).toBe('outside-world-height');
  });

  it('brings a placed station into reach', () => {
    const world = new SymbolicWorld({
      inventory: { crafting_table: 1, oak_planks: 8, stick: 4 },
      agent: { x: 0, y: 64, z: 0 },
    });
    expect(world.craftingTableInReach).toBe(false);
    expect(world.place('crafting_table', { x: 1, y: 64, z: 0 }).ok).toBe(true);
    expect(world.craftingTableInReach).toBe(true);
    expect(world.craft('wooden_pickaxe').ok).toBe(true);
  });
});

describe('move', () => {
  const walker = (): SymbolicWorld =>
    new SymbolicWorld({ agent: { x: 0, y: 64, z: 0 } });

  it('steps to an adjacent cell, diagonals included', () => {
    const world = walker();
    const result = world.move({ x: 1, y: 65, z: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toEqual({ x: 1, y: 65, z: 0 });
    expect(world.agentPosition).toEqual({ x: 1, y: 65, z: 0 });
  });

  it('refuses a jump longer than one step', () => {
    const world = walker();
    const result = world.move({ x: 5, y: 64, z: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-reach');

    // The altitude goal is out of reach twice over: a step is one cell, and
    // y = 5000 is above the build limit either way.
    const leap = world.move({ x: 0, y: 5000, z: 0 });
    expect(leap.ok).toBe(false);
    if (leap.ok) return;
    expect(leap.reason).toBe('outside-world-height');
    expect(world.agentPosition).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('refuses to walk into a block', () => {
    const world = new SymbolicWorld({
      agent: { x: 0, y: 64, z: 0 },
      blocks: [{ position: { x: 1, y: 64, z: 0 }, name: 'cobblestone' }],
    });
    const result = world.move({ x: 1, y: 64, z: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('position-occupied');
  });

  it('refuses a fractional target and one above the build limit', () => {
    const world = walker();
    const fractional = world.move({ x: 0, y: 64.5, z: 0 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.reason).toBe('invalid-position');

    const ceiling = new SymbolicWorld({ agent: { x: 0, y: 319, z: 0 } }).move({
      x: 0,
      y: 320,
      z: 0,
    });
    expect(ceiling.ok).toBe(false);
    if (ceiling.ok) return;
    expect(ceiling.reason).toBe('outside-world-height');
  });

  it('cannot climb past the build limit however long it walks', () => {
    const world = new SymbolicWorld({ agent: { x: 0, y: 300, z: 0 } });
    for (let i = 0; i < 100; i++) {
      world.move({ x: 0, y: world.agentPosition.y + 1, z: 0 });
    }
    expect(world.agentPosition.y).toBe(319);
  });
});

describe('spatial queries', () => {
  it('finds a named block within a radius and not beyond it', () => {
    const world = new SymbolicWorld({
      agent: { x: 0, y: 64, z: 0 },
      blocks: [
        { position: { x: 3, y: 64, z: 0 }, name: 'crafting_table' },
        { position: { x: 9, y: 64, z: 0 }, name: 'crafting_table' },
        { position: { x: 1, y: 64, z: 0 }, name: 'furnace' },
      ],
    });
    expect(world.blocksWithin('crafting_table', 4)).toHaveLength(1);
    expect(world.blocksWithin('crafting_table', 2)).toHaveLength(0);
    expect(world.blocksWithin('crafting_table', 20)).toHaveLength(2);
    expect(world.blocksWithin('dirt', 20)).toHaveLength(0);
  });

  it('detects a sealed cell and rejects one with a gap', () => {
    const faces = [
      { x: 1, y: 64, z: 0 },
      { x: -1, y: 64, z: 0 },
      { x: 0, y: 65, z: 0 },
      { x: 0, y: 63, z: 0 },
      { x: 0, y: 64, z: 1 },
      { x: 0, y: 64, z: -1 },
    ];
    const sealed = new SymbolicWorld({
      agent: { x: 0, y: 64, z: 0 },
      blocks: faces.map((position) => ({ position, name: 'cobblestone' })),
    });
    expect(sealed.enclosed).toBe(true);
    expect(sealed.openFaces()).toEqual([]);

    const gapped = new SymbolicWorld({
      agent: { x: 0, y: 64, z: 0 },
      blocks: faces
        .slice(0, 5)
        .map((position) => ({ position, name: 'cobblestone' })),
    });
    expect(gapped.enclosed).toBe(false);
    expect(gapped.openFaces()).toEqual([{ x: 0, y: 64, z: -1 }]);
  });

  it('counts only the six faces: a diagonal neighbour is not a wall', () => {
    const world = new SymbolicWorld({
      agent: { x: 0, y: 64, z: 0 },
      blocks: [{ position: { x: 1, y: 65, z: 0 }, name: 'cobblestone' }],
    });
    expect(world.openFaces()).toHaveLength(6);
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
