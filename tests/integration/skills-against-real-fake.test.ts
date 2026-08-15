import { beforeEach, describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import type { FakeActuatorPort } from '../../src/embodiment/fake/index.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';
import type { OfflineSession } from '../../src/runtime/bootstrap.js';
import type { SkillResult } from '../../src/skills/types.js';

/**
 * The seam between the core skill library and the real in-memory body.
 *
 * `tests/skills/library/harness.ts` builds its own world and its own actuators,
 * so every skill in `CORE_SKILLS` has been exercised only against a double
 * written alongside it. This file runs the same skills against
 * `src/embodiment/fake/`: the real `FakeWorld`, the real `FakeActuatorPort`, a
 * real `PerceptionAdapter` behind a real `PerceptionGate`, and the real
 * `SkillRunner`, all assembled by `createOfflineSession`.
 *
 * Every assertion below is about the world, not about the skill's own report.
 * A skill that claims to have dug a block has to have left a hole.
 */

interface Rig {
  readonly world: FakeWorld;
  readonly session: OfflineSession;
  readonly actuators: FakeActuatorPort;
  run(name: string, input: unknown): Promise<SkillResult<unknown>>;
}

/** Everything the assembly layer builds, over a world a test put there. */
function rig(world: FakeWorld): Rig {
  const clock = new ManualClock(1_000);
  // No reflex loop: this file is about skills, and a timer firing mid-assertion
  // would make the world change for reasons the test did not ask for.
  const session = createOfflineSession({
    world,
    clock,
    autoStart: false,
    log: silentLogger,
  });
  return {
    world,
    session,
    actuators: session.body.actuators,
    run: (name, input) =>
      session.invoker.run(name, input, {
        world: session.world,
        act: session.act,
        clock,
        log: silentLogger,
        signal: new AbortController().signal,
      }),
  };
}

/** Assert success and hand back the value, with the failure text on failure. */
function value(result: SkillResult<unknown>): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.kind}: ${result.message}`);
  }
  return result.value as Record<string, unknown>;
}

/**
 * A flat stone floor at y = 63, so the body has somewhere to stand.
 *
 * The fake body walks rather than teleports, and refuses a route with no
 * ground under it, so a world with no floor is a world where every skill that
 * moves fails for a reason that has nothing to do with the skill.
 */
const FLOOR_Y = 63;
const FLOOR_RADIUS = 24;

function floored(): FakeWorld {
  const w = new FakeWorld();
  w.fill(
    { x: -FLOOR_RADIUS, y: FLOOR_Y, z: -FLOOR_RADIUS },
    { x: FLOOR_RADIUS, y: FLOOR_Y, z: FLOOR_RADIUS },
    'stone',
  );
  return w;
}

let world: FakeWorld;
let r: Rig;

beforeEach(() => {
  world = floored();
  r = rig(world);
});

describe('movement against the real fake', () => {
  it('goToPosition actually moves the body', async () => {
    const result = await r.run('goToPosition', {
      position: { x: 8, y: 64, z: 0 },
      range: 1,
    });

    expect(result.ok).toBe(true);
    const body = world.body();
    expect(body.position.x).toBeGreaterThan(6);
    expect(body.position.x).toBeLessThanOrEqual(8);
    // The eyes moved with the feet, which is what every sight check depends on.
    expect(body.eyePosition.y).toBeCloseTo(body.position.y + 1.62, 5);
    expect(r.actuators.actionsOfKind('moveTo')).toHaveLength(1);
  });

  it('lookAt turns the head and the body reports the new angles', async () => {
    const out = value(
      await r.run('lookAt', { position: { x: 0, y: 64, z: -10 } }),
    );

    expect(world.body().yaw).toBeCloseTo(out['yaw'] as number, 10);
    expect(r.actuators.actionsOfKind('lookAt')).toHaveLength(1);
  });
});

describe('mining against the real fake', () => {
  it('digBlock removes the block and yields its drop', async () => {
    world.setBlock({ x: 1, y: 64, z: 0 }, 'stone');

    const out = value(
      await r.run('digBlock', {
        position: { x: 1, y: 64, z: 0 },
        expect: 'stone',
      }),
    );

    expect(out['name']).toBe('stone');
    expect(world.getBlock({ x: 1, y: 64, z: 0 })?.name).toBe('air');
    expect(world.countItem('stone')).toBe(1);
    expect(out['collected']).toBe(1);
  });

  it('digBlock refuses a coordinate the profile never let it sense', async () => {
    world.setUnloaded({ x: 1, y: 64, z: 0 });

    const result = await r.run('digBlock', {
      position: { x: 1, y: 64, z: 0 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(r.actuators.actionsOfKind('dig')).toHaveLength(0);
  });

  it('collectBlock finds, approaches and breaks several blocks', async () => {
    // Spread rather than collinear: three logs in a row would occlude each
    // other under fair-play and this test would be measuring sight, not mining.
    world.setBlock({ x: 4, y: 64, z: 0 }, 'oak_log');
    world.setBlock({ x: 5, y: 64, z: 4 }, 'oak_log');
    world.setBlock({ x: 6, y: 64, z: -4 }, 'oak_log');

    const out = value(
      await r.run('collectBlock', { name: 'oak_log', count: 3 }),
    );

    expect(out['dug']).toBe(3);
    expect(world.countItem('oak_log')).toBe(3);
    expect(world.getBlock({ x: 4, y: 64, z: 0 })?.name).toBe('air');
    expect(world.getBlock({ x: 5, y: 64, z: 4 })?.name).toBe('air');
    expect(world.getBlock({ x: 6, y: 64, z: -4 })?.name).toBe('air');
  });
});

describe('building against the real fake', () => {
  it('placeBlock puts a carried block into the world', async () => {
    world.setInventory([{ name: 'cobblestone', count: 4 }]);
    world.setBlock({ x: 2, y: 64, z: 0 }, 'stone');

    const out = value(
      await r.run('placeBlock', {
        item: 'cobblestone',
        against: { x: 2, y: 64, z: 0 },
        face: { x: 0, y: 1, z: 0 },
      }),
    );

    expect(out['confirmed']).toBe(true);
    expect(world.getBlock({ x: 2, y: 65, z: 0 })?.name).toBe('cobblestone');
    expect(world.countItem('cobblestone')).toBe(3);
  });
});

describe('crafting against the real fake', () => {
  it('craftItem consumes inputs and produces output on the 2x2 grid', async () => {
    world.setInventory([{ name: 'oak_planks', count: 2 }]);
    world.addRecipe('stick', {
      inputs: [{ name: 'oak_planks', count: 2 }],
      output: { name: 'stick', count: 4 },
    });

    const out = value(
      await r.run('craftItem', {
        item: 'stick',
        count: 1,
        useCraftingTable: false,
      }),
    );

    expect(out['usedCraftingTable']).toBe(false);
    expect(world.countItem('stick')).toBe(4);
    expect(world.countItem('oak_planks')).toBe(0);
  });

  it('craftItem walks to a known table for a recipe that needs one', async () => {
    world.setInventory([
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 },
    ]);
    world.setBlock({ x: 3, y: 64, z: 0 }, 'crafting_table');
    world.addRecipe('wooden_pickaxe', {
      inputs: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
      ],
      requiresTable: true,
    });

    const out = value(
      await r.run('craftItem', {
        item: 'wooden_pickaxe',
        count: 1,
        useCraftingTable: true,
      }),
    );

    expect(out['usedCraftingTable']).toBe(true);
    expect(world.countItem('wooden_pickaxe')).toBe(1);
    expect(world.countItem('oak_planks')).toBe(0);
    // The table was reached, not merely referenced.
    expect(
      r.actuators.actionsOfKind('craft')[0]?.args['craftingTable'],
    ).toEqual({ x: 3, y: 64, z: 0 });
  });
});

describe('containers against the real fake', () => {
  const chest = { x: 2, y: 64, z: 0 };

  it('withdrawItems takes items out of the chest and closes it', async () => {
    world.setBlock(chest, 'chest');
    world.setContainer(chest, 'chest', [{ name: 'coal', count: 5 }]);

    const out = value(
      await r.run('withdrawItems', {
        position: chest,
        items: [{ name: 'coal', count: 3 }],
      }),
    );

    expect(out['total']).toBe(3);
    expect(world.countItem('coal')).toBe(3);
    expect(world.getContainer(chest)?.contents).toEqual([
      { name: 'coal', count: 2 },
    ]);
    // A container left open blocks every later interaction, so the skill must
    // close it whatever happened.
    expect(r.actuators.actionsOfKind('closeContainer')).toHaveLength(1);
  });

  it('depositItems puts items into the chest', async () => {
    world.setBlock(chest, 'chest');
    world.setContainer(chest, 'chest', []);
    world.setInventory([{ name: 'iron_ingot', count: 6 }]);

    const out = value(
      await r.run('depositItems', {
        position: chest,
        items: [{ name: 'iron_ingot', count: 4 }],
      }),
    );

    expect(out['total']).toBe(4);
    expect(world.countItem('iron_ingot')).toBe(2);
    expect(world.getContainer(chest)?.contents).toEqual([
      { name: 'iron_ingot', count: 4 },
    ]);
  });
});

describe('inventory against the real fake', () => {
  it('equipItem moves the item into the named slot', async () => {
    world.setInventory([{ name: 'iron_pickaxe', count: 1 }]);

    const out = value(
      await r.run('equipItem', { item: 'iron_pickaxe', destination: 'hand' }),
    );

    expect(out['destination']).toBe('hand');
    expect(world.equipment()['hand']).toEqual({
      name: 'iron_pickaxe',
      count: 1,
    });
  });

  it('consumeItem eats the item and the body says so', async () => {
    world.setBody({ food: 10 });
    world.setInventory([{ name: 'bread', count: 2 }]);

    const out = value(await r.run('consumeItem', { item: 'bread' }));

    expect(out['foodBefore']).toBe(10);
    expect(out['foodAfter']).toBe(14);
    expect(world.body().food).toBe(14);
    expect(world.countItem('bread')).toBe(1);
  });

  it('dropItem takes the stack out of the inventory and onto the ground', async () => {
    world.setInventory([{ name: 'dirt', count: 5 }]);

    const out = value(await r.run('dropItem', { item: 'dirt', count: 2 }));

    expect(out['dropped']).toBe(2);
    expect(world.countItem('dirt')).toBe(3);
    expect(world.entities().some((e) => e.name === 'dirt')).toBe(true);
  });
});

describe('combat against the real fake', () => {
  it('attackEntity swings until the mob is gone', async () => {
    world.addEntity({
      id: 7,
      name: 'zombie',
      kind: 'mob',
      position: { x: 2, y: 64, z: 0 },
      health: 10,
      hostile: true,
    });

    const out = value(await r.run('attackEntity', { name: 'zombie' }));

    expect(out['defeated']).toBe(true);
    expect(world.getEntity(7)).toBeUndefined();
    expect(r.actuators.actionsOfKind('attack').length).toBeGreaterThan(0);
  });
});

describe('social against the real fake', () => {
  it('sendChat reaches the body chat log', async () => {
    const out = value(await r.run('sendChat', { message: 'hello world' }));

    expect(out['private']).toBe(false);
    expect(r.actuators.chatLog).toEqual(['hello world']);
  });

  it('sendChat refuses to run a server command', async () => {
    const result = await r.run('sendChat', { message: '/op me' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(r.actuators.chatLog).toEqual([]);
  });
});

describe('the ledger over a whole skill run', () => {
  it('counts only fair-play provenance while skills drive the body', async () => {
    world.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
    await r.run('digBlock', { position: { x: 1, y: 64, z: 0 } });

    const report = r.session.world.report();
    expect(report.total).toBeGreaterThan(0);
    expect(report.privileged).toBe(0);
    expect(report.fairPlay).toBe(true);
  });
});
