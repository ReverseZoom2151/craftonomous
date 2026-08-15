import { describe, expect, it } from 'vitest';

import {
  FakeWorld,
  createFakeEmbodiment,
  isStandable,
  planPath,
} from '../../src/embodiment/fake/index.js';
import type { FakeEmbodiment } from '../../src/embodiment/fake/index.js';
import { distance } from '../../src/embodiment/geometry.js';
import type { Vec3Like } from '../../src/embodiment/geometry.js';

/**
 * The fake body walks.
 *
 * It used to teleport, which made this suite blind to a whole class of bug: a
 * skill that assumed it could reach somewhere unreachable passed offline and
 * failed the moment it met a server. These tests exist to keep the fake no more
 * capable than a real body, so each one is a thing a real server would refuse.
 */

const GROUND_Y = 63;
const FEET_Y = 64;

/** A flat stone plain with the body standing on it at the origin. */
function plain(radius = 8): FakeWorld {
  const world = new FakeWorld();
  world.fill(
    { x: -radius, y: GROUND_Y, z: -radius },
    { x: radius, y: GROUND_Y, z: radius },
    'stone',
  );
  world.setBody({ position: { x: 0.5, y: FEET_Y, z: 0.5 } });
  return world;
}

function bodyAt(world: FakeWorld): Vec3Like {
  return world.body().position;
}

describe('walkability rules', () => {
  it('needs headroom, a clear cell and solid ground', () => {
    const world = plain();
    expect(isStandable(world, { x: 2, y: FEET_Y, z: 0 })).toBe(true);

    // Feet blocked.
    world.setBlock({ x: 2, y: FEET_Y, z: 0 }, 'stone');
    expect(isStandable(world, { x: 2, y: FEET_Y, z: 0 })).toBe(false);
    world.setBlock({ x: 2, y: FEET_Y, z: 0 }, 'air');

    // Head blocked.
    world.setBlock({ x: 2, y: FEET_Y + 1, z: 0 }, 'stone');
    expect(isStandable(world, { x: 2, y: FEET_Y, z: 0 })).toBe(false);
    world.setBlock({ x: 2, y: FEET_Y + 1, z: 0 }, 'air');

    // Nothing underfoot.
    world.setBlock({ x: 2, y: GROUND_Y, z: 0 }, 'air');
    expect(isStandable(world, { x: 2, y: FEET_Y, z: 0 })).toBe(false);
  });

  it('does not treat unloaded ground as ground', () => {
    const world = plain();
    world.setUnloaded({ x: 2, y: GROUND_Y, z: 0 });
    expect(isStandable(world, { x: 2, y: FEET_Y, z: 0 })).toBe(false);
  });
});

describe('FakeActuatorPort.moveTo walks', () => {
  let embodiment: FakeEmbodiment;
  let world: FakeWorld;

  function on(w: FakeWorld): FakeEmbodiment {
    world = w;
    embodiment = createFakeEmbodiment(w);
    return embodiment;
  }

  it('walks a clear path and ends exactly where it was asked', async () => {
    const body = on(plain());
    const target = { x: 5.5, y: FEET_Y, z: 3.5 };

    const outcome = await body.actuators.moveTo(target);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(bodyAt(world)).toEqual(target);
    // The eyes came along for the walk.
    expect(world.body().eyePosition.y).toBeCloseTo(FEET_Y + 1.62);
  });

  it('refuses a walled-off target instead of arriving anyway', async () => {
    const w = plain();
    // A closed box of stone around the target, floor to head height.
    for (const y of [FEET_Y, FEET_Y + 1]) {
      w.fill({ x: 3, y, z: 1 }, { x: 7, y, z: 1 }, 'stone');
      w.fill({ x: 3, y, z: 5 }, { x: 7, y, z: 5 }, 'stone');
      w.fill({ x: 3, y, z: 1 }, { x: 3, y, z: 5 }, 'stone');
      w.fill({ x: 7, y, z: 1 }, { x: 7, y, z: 5 }, 'stone');
    }
    const body = on(w);
    const before = bodyAt(world);

    const outcome = await body.actuators.moveTo({ x: 5.5, y: FEET_Y, z: 3.5 });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no walkable route/);
    expect(bodyAt(world)).toEqual(before);
    // The refusal is in the log, not a silent nothing.
    const logged = body.actuators.actionsOfKind('moveTo');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.ok).toBe(false);
  });

  it('steps up one block but not two', async () => {
    const w = plain();
    // A one-block ledge from x = 3 onward.
    w.fill({ x: 3, y: FEET_Y, z: -8 }, { x: 8, y: FEET_Y, z: 8 }, 'stone');
    const stepUp = on(w);

    const climbed = await stepUp.actuators.moveTo({
      x: 4.5,
      y: FEET_Y + 1,
      z: 0.5,
    });
    expect(climbed.ok, JSON.stringify(climbed)).toBe(true);
    expect(bodyAt(world).y).toBe(FEET_Y + 1);

    const w2 = plain();
    // The same ledge, now two blocks tall: a wall, not a step.
    w2.fill({ x: 3, y: FEET_Y, z: -8 }, { x: 8, y: FEET_Y + 1, z: 8 }, 'stone');
    const walled = on(w2);

    const blocked = await walled.actuators.moveTo({
      x: 4.5,
      y: FEET_Y + 2,
      z: 0.5,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toMatch(/no walkable route/);
    expect(bodyAt(world).y).toBe(FEET_Y);
  });

  it('drops into a shallow pit but refuses one that is too deep', async () => {
    const shallow = plain();
    // Remove the ground under a column and rebuild it three blocks down.
    shallow.fill(
      { x: 4, y: GROUND_Y, z: -1 },
      { x: 4, y: GROUND_Y, z: 1 },
      'air',
    );
    shallow.fill(
      { x: 4, y: GROUND_Y - 3, z: -1 },
      { x: 4, y: GROUND_Y - 3, z: 1 },
      'stone',
    );
    const shallowBody = on(shallow);

    const dropped = await shallowBody.actuators.moveTo({
      x: 4.5,
      y: GROUND_Y - 2,
      z: 0.5,
    });
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(bodyAt(world).y).toBe(GROUND_Y - 2);

    const deep = plain();
    deep.fill({ x: 4, y: GROUND_Y, z: -1 }, { x: 4, y: GROUND_Y, z: 1 }, 'air');
    deep.fill(
      { x: 4, y: GROUND_Y - 9, z: -1 },
      { x: 4, y: GROUND_Y - 9, z: 1 },
      'stone',
    );
    const deepBody = on(deep);

    const refused = await deepBody.actuators.moveTo({
      x: 4.5,
      y: GROUND_Y - 8,
      z: 0.5,
    });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/no walkable route/);
    expect(bodyAt(world).y).toBe(FEET_Y);
  });

  it('will not route through an unknown region', async () => {
    const w = plain();
    // A full-height curtain of unloaded cells, so the only way across is
    // through chunks nobody has sent.
    for (let z = -8; z <= 8; z += 1) {
      for (let y = GROUND_Y - 4; y <= FEET_Y + 3; y += 1) {
        w.setUnloaded({ x: 3, y, z });
      }
    }
    const body = on(w);

    const outcome = await body.actuators.moveTo({ x: 5.5, y: FEET_Y, z: 0.5 });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no walkable route/);
    expect(bodyAt(world).x).toBeLessThan(3);
  });

  it('arriving within range counts as success', async () => {
    const body = on(plain());
    // A pillar standing exactly where the target is: unreachable itself, but
    // its neighbours are inside a range of two.
    world.fill(
      { x: 5, y: FEET_Y, z: 0 },
      { x: 5, y: FEET_Y + 1, z: 0 },
      'stone',
    );

    const outcome = await body.actuators.moveTo(
      { x: 5.5, y: FEET_Y, z: 0.5 },
      { range: 2 },
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const settled = distance(bodyAt(world), { x: 5.5, y: FEET_Y, z: 0.5 });
    expect(settled).toBeLessThanOrEqual(2);
    expect(settled).toBeGreaterThan(0);
  });

  it('refuses rather than hanging when the node cap is hit', async () => {
    // A large open plain, so a hopeless search has plenty to chew on.
    const w = plain(60);
    // An island the body cannot leave, with the target far outside it.
    for (const y of [FEET_Y, FEET_Y + 1]) {
      w.fill({ x: -3, y, z: -3 }, { x: 3, y, z: -3 }, 'stone');
      w.fill({ x: -3, y, z: 3 }, { x: 3, y, z: 3 }, 'stone');
      w.fill({ x: -3, y, z: -3 }, { x: -3, y, z: 3 }, 'stone');
      w.fill({ x: 3, y, z: -3 }, { x: 3, y, z: 3 }, 'stone');
    }
    const body = on(w);
    // A cap smaller than the enclosure would need, so the cap is what stops it.
    body.actuators.pathLimits = { maxDrop: 3, maxNodes: 4 };

    const outcome = await body.actuators.moveTo({ x: 50.5, y: FEET_Y, z: 0.5 });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/gave up after exploring 4 cells/);
    expect(bodyAt(world)).toEqual({ x: 0.5, y: FEET_Y, z: 0.5 });
  });

  it('an abort mid-walk leaves the body partway', async () => {
    const body = on(plain(20));
    const controller = new AbortController();
    body.actuators.onStep = ({ step }) => {
      if (step === 3) controller.abort();
    };

    const outcome = await body.actuators.moveTo(
      { x: 10.5, y: FEET_Y, z: 0.5 },
      { signal: controller.signal },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/aborted after 3 of 10 steps/);
    // Three steps along, not back at the start and not at the target.
    expect(bodyAt(world)).toEqual({ x: 3.5, y: FEET_Y, z: 0.5 });
    // And the log says so rather than claiming a clean arrival.
    expect(body.actuators.actions.at(-1)).toMatchObject({
      kind: 'moveTo',
      ok: false,
    });
  });

  it('refuses to start when the body has nothing under its feet', async () => {
    const w = new FakeWorld();
    w.setBody({ position: { x: 0.5, y: FEET_Y, z: 0.5 } });
    const body = on(w);

    const outcome = await body.actuators.moveTo({ x: 4.5, y: FEET_Y, z: 0.5 });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/not standing on solid ground/);
  });

  it('swims in three dimensions when the body is in a fluid', async () => {
    const w = new FakeWorld();
    w.setBody({ position: { x: 0.5, y: FEET_Y, z: 0.5 }, inWater: true });
    const body = on(w);

    const outcome = await body.actuators.moveTo(
      { x: 0.5, y: FEET_Y + 4, z: 0.5 },
      { range: 1 },
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(bodyAt(world).y).toBeGreaterThan(FEET_Y);
  });
});

describe('planPath is deterministic', () => {
  it('returns the same route for the same world every time', () => {
    const world = plain(12);
    const runs = Array.from({ length: 5 }, () =>
      planPath(
        world,
        { x: 0.5, y: FEET_Y, z: 0.5 },
        { x: 6.5, y: FEET_Y, z: 4.5 },
      ),
    );
    const first = JSON.stringify(runs[0]);
    for (const run of runs) expect(JSON.stringify(run)).toBe(first);
  });
});

describe('actuators that reach need the body to be near', () => {
  it('refuses to place, open or swing at something out of reach', async () => {
    const w = plain(20);
    w.setBlock({ x: 15, y: FEET_Y, z: 0 }, 'stone');
    w.setBlock({ x: 15, y: FEET_Y, z: 2 }, 'chest');
    w.setContainer({ x: 15, y: FEET_Y, z: 2 }, 'chest', [
      { name: 'coal', count: 4 },
    ]);
    w.addEntity({
      id: 3,
      name: 'zombie',
      kind: 'mob',
      position: { x: 15, y: FEET_Y, z: 4 },
      health: 20,
    });
    w.setInventory([{ name: 'cobblestone', count: 4 }]);
    const body = createFakeEmbodiment(w);

    expect(
      (
        await body.actuators.placeBlock(
          { x: 15, y: FEET_Y, z: 0 },
          { x: 0, y: 1, z: 0 },
          'cobblestone',
        )
      ).detail,
    ).toBe('out of reach');
    expect(
      await body.actuators.openContainer({ x: 15, y: FEET_Y, z: 2 }),
    ).toBeUndefined();
    expect((await body.actuators.attack(3)).detail).toBe('out of reach');

    // Walk over and the very same actions now succeed, which is the point:
    // the fix is to move the body, not to relax the rule.
    const walked = await body.actuators.moveTo({ x: 14.5, y: FEET_Y, z: 1.5 });
    expect(walked.ok, JSON.stringify(walked)).toBe(true);

    expect(
      (
        await body.actuators.placeBlock(
          { x: 15, y: FEET_Y, z: 0 },
          { x: 0, y: 1, z: 0 },
          'cobblestone',
        )
      ).ok,
    ).toBe(true);
    expect(
      (await body.actuators.openContainer({ x: 15, y: FEET_Y, z: 2 }))?.kind,
    ).toBe('chest');
    expect((await body.actuators.withdraw('coal', 2)).ok).toBe(true);
  });
});
