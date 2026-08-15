import { beforeEach, describe, expect, it } from 'vitest';

import { FakeWorld, createFakeEmbodiment } from '../../src/embodiment/fake/index.js';
import type { FakeEmbodiment } from '../../src/embodiment/fake/index.js';
import { PerceptionGate } from '../../src/perception/gate.js';
import { FAIR_PLAY, XRAY } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { distance } from '../../src/embodiment/geometry.js';

const EYE = { x: 0.5, y: 65.5, z: 0.5 };

/** A body standing at the origin with a stone wall at x = 3. */
function walledWorld(): FakeWorld {
  const world = new FakeWorld();
  world.setBody({ position: { x: 0.5, y: 64, z: 0.5 }, eyePosition: EYE });
  world.fill({ x: 3, y: 60, z: -5 }, { x: 3, y: 70, z: 5 }, 'stone');
  world.setBlock({ x: 6, y: 65, z: 0 }, 'iron_ore');
  return world;
}

describe('FakeWorld', () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = new FakeWorld();
  });

  it('reads unset coordinates as air', () => {
    expect(world.getBlock({ x: 12, y: -3, z: 40 })).toEqual({
      name: 'air',
      position: { x: 12, y: -3, z: 40 },
      solid: false,
    });
    expect(world.isSolid({ x: 12, y: -3, z: 40 })).toBe(false);
  });

  it('infers solidity from the block name and lets a caller override it', () => {
    world.setBlock({ x: 0, y: 0, z: 0 }, 'stone');
    world.setBlock({ x: 1, y: 0, z: 0 }, 'water');
    world.setBlock({ x: 2, y: 0, z: 0 }, 'glass_pane', false);
    expect(world.isSolid({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(world.isSolid({ x: 1, y: 0, z: 0 })).toBe(false);
    expect(world.isSolid({ x: 2, y: 0, z: 0 })).toBe(false);
  });

  it('floors fractional coordinates onto the containing block', () => {
    world.setBlock({ x: 4.9, y: 2.2, z: -0.1 }, 'dirt');
    expect(world.getBlock({ x: 4.1, y: 2.9, z: -0.9 })?.name).toBe('dirt');
  });

  it('fills an inclusive box regardless of corner order', () => {
    world.fill({ x: 2, y: 2, z: 2 }, { x: 0, y: 0, z: 0 }, 'stone');
    expect(world.isSolid({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(world.isSolid({ x: 2, y: 2, z: 2 })).toBe(true);
    expect(world.isSolid({ x: 3, y: 0, z: 0 })).toBe(false);
  });

  it('distinguishes unloaded from empty', () => {
    world.setUnloaded({ x: 100, y: 0, z: 0 });
    expect(world.getBlock({ x: 100, y: 0, z: 0 })).toBeUndefined();
    // Unknown matter cannot block sight, so it is not solid either.
    expect(world.isSolid({ x: 100, y: 0, z: 0 })).toBe(false);
  });

  it('moves the eyes with the feet unless told otherwise', () => {
    world.setBody({ position: { x: 10, y: 70, z: -4 } });
    expect(world.body().eyePosition).toEqual({ x: 10, y: 71.62, z: -4 });
    world.setBody({ position: { x: 0, y: 0, z: 0 }, eyePosition: { x: 9, y: 9, z: 9 } });
    expect(world.body().eyePosition).toEqual({ x: 9, y: 9, z: 9 });
  });

  it('merges and splits inventory stacks', () => {
    world.setInventory([{ name: 'oak_log', count: 3 }]);
    world.addItem('oak_log', 2);
    expect(world.countItem('oak_log')).toBe(5);
    expect(world.removeItem('oak_log', 4)).toBe(true);
    expect(world.countItem('oak_log')).toBe(1);
    expect(world.removeItem('oak_log', 9)).toBe(false);
    expect(world.countItem('oak_log')).toBe(1);
  });

  it('finds named blocks nearest first', () => {
    world.setBlock({ x: 10, y: 0, z: 0 }, 'iron_ore');
    world.setBlock({ x: 2, y: 0, z: 0 }, 'iron_ore');
    world.setBlock({ x: 5, y: 0, z: 0 }, 'coal_ore');
    const found = world.findBlocks({
      origin: { x: 0, y: 0, z: 0 },
      names: ['iron_ore'],
      maxDistance: 64,
      limit: 10,
    });
    expect(found.map((b) => b.position.x)).toEqual([2, 10]);
  });
});

describe('FakeSensorPort', () => {
  it('answers occlusion with the raycast against the world', () => {
    const embodiment = createFakeEmbodiment(walledWorld());
    const ore = { x: 6.5, y: 65.5, z: 0.5 };
    expect(embodiment.sensors.isOccluded(EYE, ore)).toBe(true);
  });

  it('sees a target on the near side of the wall', () => {
    const embodiment = createFakeEmbodiment(walledWorld());
    expect(embodiment.sensors.isOccluded(EYE, { x: 2.5, y: 65.5, z: 0.5 })).toBe(false);
  });

  it('reports entities and inventory without filtering', () => {
    const world = walledWorld();
    world.addEntity({
      id: 1,
      name: 'zombie',
      kind: 'mob',
      position: { x: 8, y: 65, z: 0 },
      hostile: true,
      health: 20,
    });
    world.setInventory([{ name: 'stone_pickaxe', count: 1 }]);
    const embodiment = createFakeEmbodiment(world);
    expect(embodiment.sensors.entities()).toHaveLength(1);
    expect(embodiment.sensors.inventory()[0]?.name).toBe('stone_pickaxe');
    expect(embodiment.sensors.body().health).toBe(20);
  });

  it('finds blocks relative to the body', () => {
    const embodiment = createFakeEmbodiment(walledWorld());
    const found = embodiment.sensors.findBlocks({
      names: ['iron_ore'],
      maxDistance: 32,
      limit: 5,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.position).toEqual({ x: 6, y: 65, z: 0 });
  });
});

describe('perception profiles over the fake body', () => {
  it('hides ore behind stone under fair-play but not under xray', () => {
    const embodiment = createFakeEmbodiment(walledWorld());
    const ore = { x: 6.5, y: 65.5, z: 0.5 };
    const check = {
      distance: distance(EYE, ore),
      occluded: embodiment.sensors.isOccluded(EYE, ore),
    };

    const fair = new PerceptionGate(FAIR_PLAY, new ManualClock());
    const xray = new PerceptionGate(XRAY, new ManualClock());

    expect(fair.sight('iron_ore', check)).toBeUndefined();
    expect(xray.sight('iron_ore', check)?.value).toBe('iron_ore');
  });
});

describe('FakeActuatorPort', () => {
  let embodiment: FakeEmbodiment;
  let world: FakeWorld;

  beforeEach(() => {
    world = walledWorld();
    embodiment = createFakeEmbodiment(world);
  });

  it('digging through the wall changes occlusion', async () => {
    const ore = { x: 6.5, y: 65.5, z: 0.5 };
    expect(embodiment.sensors.isOccluded(EYE, ore)).toBe(true);

    const outcome = await embodiment.actuators.dig({ x: 3, y: 65, z: 0 });
    expect(outcome.ok).toBe(true);

    expect(world.getBlock({ x: 3, y: 65, z: 0 })?.name).toBe('air');
    expect(embodiment.sensors.isOccluded(EYE, ore)).toBe(false);
  });

  it('digging yields the block as an item', async () => {
    await embodiment.actuators.dig({ x: 3, y: 65, z: 0 });
    expect(world.countItem('stone')).toBe(1);
  });

  it('refuses to dig air, unloaded chunks and out-of-reach blocks', async () => {
    expect((await embodiment.actuators.dig({ x: 1, y: 65, z: 0 })).ok).toBe(false);
    world.setUnloaded({ x: 3, y: 66, z: 0 });
    expect((await embodiment.actuators.dig({ x: 3, y: 66, z: 0 })).ok).toBe(false);
    expect((await embodiment.actuators.dig({ x: 3, y: 65, z: 200 })).ok).toBe(false);
  });

  it('teleports the body on moveTo and stops short when given a range', async () => {
    await embodiment.actuators.moveTo({ x: 0.5, y: 64, z: 10.5 });
    expect(world.body().position).toEqual({ x: 0.5, y: 64, z: 10.5 });
    expect(world.body().eyePosition.y).toBeCloseTo(65.62);

    await embodiment.actuators.moveTo({ x: 0.5, y: 64, z: 0.5 }, { range: 4 });
    expect(distance(world.body().position, { x: 0.5, y: 64, z: 0.5 })).toBeCloseTo(4);
  });

  it('refuses to move when the signal is already aborted', async () => {
    const before = world.body().position;
    const controller = new AbortController();
    controller.abort();
    const outcome = await embodiment.actuators.moveTo(
      { x: 50, y: 64, z: 50 },
      { signal: controller.signal },
    );
    expect(outcome).toEqual({ ok: false, detail: 'aborted' });
    expect(world.body().position).toEqual(before);
  });

  it('places a block from the inventory against a solid face', async () => {
    world.setInventory([{ name: 'cobblestone', count: 2 }]);
    const outcome = await embodiment.actuators.placeBlock(
      { x: 3, y: 65, z: 0 },
      { x: -1, y: 0, z: 0 },
      'cobblestone',
    );
    expect(outcome.ok).toBe(true);
    expect(world.getBlock({ x: 2, y: 65, z: 0 })?.name).toBe('cobblestone');
    expect(world.countItem('cobblestone')).toBe(1);
  });

  it('refuses to place without the item', async () => {
    const outcome = await embodiment.actuators.placeBlock(
      { x: 3, y: 65, z: 0 },
      { x: -1, y: 0, z: 0 },
      'cobblestone',
    );
    expect(outcome.ok).toBe(false);
    expect(world.getBlock({ x: 2, y: 65, z: 0 })?.name).toBe('air');
  });

  it('crafts by consuming inputs and producing outputs', async () => {
    world.addRecipe('oak_planks', {
      inputs: [{ name: 'oak_log', count: 1 }],
      output: { name: 'oak_planks', count: 4 },
    });
    world.setInventory([{ name: 'oak_log', count: 3 }]);

    const outcome = await embodiment.actuators.craft('oak_planks', 2);
    expect(outcome.ok).toBe(true);
    expect(world.countItem('oak_log')).toBe(1);
    expect(world.countItem('oak_planks')).toBe(8);
  });

  it('fails a craft with unknown recipes, missing inputs or a missing table', async () => {
    world.addRecipe('stone_pickaxe', {
      inputs: [
        { name: 'cobblestone', count: 3 },
        { name: 'stick', count: 2 },
      ],
      requiresTable: true,
    });
    expect((await embodiment.actuators.craft('diamond_sword', 1)).ok).toBe(false);
    expect((await embodiment.actuators.craft('stone_pickaxe', 1)).ok).toBe(false);

    world.setInventory([
      { name: 'cobblestone', count: 3 },
      { name: 'stick', count: 2 },
    ]);
    expect((await embodiment.actuators.craft('stone_pickaxe', 1)).ok).toBe(false);
    const withTable = await embodiment.actuators.craft('stone_pickaxe', 1, {
      craftingTable: { x: 1, y: 64, z: 0 },
    });
    expect(withTable.ok).toBe(true);
    expect(world.countItem('stone_pickaxe')).toBe(1);
    expect(world.countItem('cobblestone')).toBe(0);
  });

  it('damages and eventually removes an entity', async () => {
    world.addEntity({
      id: 7,
      name: 'zombie',
      kind: 'mob',
      position: { x: 2, y: 64, z: 0 },
      health: 10,
      hostile: true,
    });
    expect((await embodiment.actuators.attack(7)).ok).toBe(true);
    expect(world.getEntity(7)?.health).toBe(5);
    await embodiment.actuators.attack(7);
    expect(world.getEntity(7)).toBeUndefined();
    expect((await embodiment.actuators.attack(7)).ok).toBe(false);
  });

  it('moves items in and out of a container', async () => {
    world.setContainer({ x: 1, y: 64, z: 0 }, 'chest', [{ name: 'coal', count: 10 }]);
    world.setInventory([{ name: 'oak_log', count: 4 }]);

    expect((await embodiment.actuators.withdraw('coal', 2)).ok).toBe(false);

    const view = await embodiment.actuators.openContainer({ x: 1, y: 64, z: 0 });
    expect(view?.kind).toBe('chest');
    expect(view?.contents[0]).toEqual({ name: 'coal', count: 10 });

    expect((await embodiment.actuators.withdraw('coal', 4)).ok).toBe(true);
    expect(world.countItem('coal')).toBe(4);
    expect((await embodiment.actuators.deposit('oak_log', 4)).ok).toBe(true);
    expect(world.countItem('oak_log')).toBe(0);

    await embodiment.actuators.closeContainer();
    expect((await embodiment.actuators.withdraw('coal', 1)).ok).toBe(false);
  });

  it('equips, consumes and drops', async () => {
    world.setInventory([
      { name: 'bread', count: 2 },
      { name: 'iron_sword', count: 1 },
    ]);
    world.setBody({ food: 10 });

    expect((await embodiment.actuators.equip('iron_sword')).ok).toBe(true);
    expect(embodiment.sensors.equipment()['hand']?.name).toBe('iron_sword');
    expect((await embodiment.actuators.equip('netherite_axe')).ok).toBe(false);

    expect((await embodiment.actuators.consume('bread')).ok).toBe(true);
    expect(world.body().food).toBe(14);
    expect(world.countItem('bread')).toBe(1);

    expect((await embodiment.actuators.dropItem('bread', 1)).ok).toBe(true);
    expect(world.countItem('bread')).toBe(0);
    expect(embodiment.sensors.entities().some((e) => e.kind === 'item')).toBe(true);
  });

  it('turns the body towards a target on lookAt', async () => {
    await embodiment.actuators.lookAt({ x: 0.5, y: 65.5, z: 10.5 });
    // Looking down +z is yaw = pi in Minecraft's convention, and level.
    expect(Math.abs(world.body().yaw)).toBeCloseTo(Math.PI);
    expect(world.body().pitch).toBeCloseTo(0);
  });

  it('records every attempted action, successful or not', async () => {
    await embodiment.actuators.dig({ x: 3, y: 65, z: 0 });
    await embodiment.actuators.dig({ x: 1, y: 65, z: 0 });
    await embodiment.actuators.chat('hello');
    await embodiment.actuators.stop();

    const digs = embodiment.actuators.actionsOfKind('dig');
    expect(digs).toHaveLength(2);
    expect(digs[0]?.ok).toBe(true);
    expect(digs[1]?.ok).toBe(false);
    expect(embodiment.actuators.actions.map((a) => a.kind)).toEqual([
      'dig',
      'dig',
      'chat',
      'stop',
    ]);
    expect(embodiment.actuators.chatLog).toEqual(['hello']);

    embodiment.actuators.clearActions();
    expect(embodiment.actuators.actions).toHaveLength(0);
  });
});

describe('FakeEmbodiment lifecycle', () => {
  it('reports connection state and disconnects idempotently', async () => {
    const embodiment = createFakeEmbodiment();
    expect(embodiment.connected).toBe(true);
    await embodiment.disconnect();
    expect(embodiment.connected).toBe(false);
    await embodiment.disconnect();
    expect(embodiment.connected).toBe(false);
  });
});
