import { describe, expect, it } from 'vitest';

import { FakeWorld, FakeSensorPort } from '../../src/embodiment/fake/index.js';
import { vec3 } from '../../src/embodiment/geometry.js';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type { SensorPort } from '../../src/embodiment/port.js';
import { PerceptionAdapter, bearingOf } from '../../src/perception/adapter.js';
import { PerceptionGate } from '../../src/perception/gate.js';
import { WorldMemory } from '../../src/perception/memory.js';
import { FAIR_PLAY, OMNISCIENT } from '../../src/perception/profile.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';

/** The body stands at the origin, eyes at y = 65. */
function setup(profile: PerceptionProfile = FAIR_PLAY) {
  const clock = new ManualClock(1_000);
  const world = new FakeWorld();
  world.setBody({ position: vec3(0, 64, 0), eyePosition: vec3(0, 65, 0) });
  const sensors = new FakeSensorPort(world);
  const gate = new PerceptionGate(profile, clock);
  const memory = new WorldMemory(clock, { expiry: gate });
  const view = new PerceptionAdapter(sensors, gate, memory);
  return { clock, world, view } as const;
}

describe('hearing', () => {
  it('hears a sound inside the profile range and counts it as hearing', () => {
    const { world, view, clock } = setup();
    world.emitSound('entity.creeper.primed', vec3(6, 65, 0), 1);

    const heard = view.sounds();

    expect(heard).toHaveLength(1);
    expect(heard[0]?.provenance).toBe('hearing');
    expect(heard[0]?.value.name).toBe('entity.creeper.primed');
    expect(heard[0]?.sensedAt).toBe(clock.now());
    expect(view.report().counts.hearing).toBe(1);
  });

  it('does not hear a sound outside the range, and does not count it', () => {
    const { world, view } = setup();
    world.emitSound('entity.zombie.ambient', vec3(FAIR_PLAY.hearingRange + 5, 65, 0), 1);

    expect(view.sounds()).toHaveLength(0);
    expect(view.report().total).toBe(0);
  });

  it('hears the same distant sound under an omniscient profile', () => {
    const { world, view } = setup(OMNISCIENT);
    world.emitSound('entity.zombie.ambient', vec3(400, 65, 0), 1);

    expect(view.sounds()).toHaveLength(1);
    expect(view.report().counts.hearing).toBe(1);
  });

  it('gives a bearing and a distance band, never the source coordinate', () => {
    const { world, view } = setup();
    const source = vec3(0, 65, -10);
    world.emitSound('block.stone.break', source, 1);

    const heard = view.sounds()[0];

    expect(heard?.value.bearing).toBe('N');
    expect(heard?.value.band).toBe('nearby');
    expect(heard?.value.minDistance).toBe(8);
    expect(heard?.value.maxDistance).toBe(16);
    // The exact source is not on the value, under any key and at any depth.
    expect(JSON.stringify(heard?.value)).not.toContain('-10');
    expect(Object.keys(heard?.value ?? {})).not.toContain('position');
    expect(Object.keys(heard?.value ?? {})).not.toContain('approximatePosition');
  });

  it('reports elevation coarsely, not as a height', () => {
    const { world, view } = setup();
    world.emitSound('a', vec3(2, 75, 0));
    world.emitSound('b', vec3(2, 65.5, 0));
    world.emitSound('c', vec3(2, 55, 0));

    expect(view.sounds().map((o) => o.value.elevation)).toEqual([
      'above',
      'level',
      'below',
    ]);
  });

  it('drains: a sound heard once is not heard again', () => {
    const { world, view } = setup();
    world.emitSound('entity.creeper.primed', vec3(3, 65, 0));

    expect(view.sounds()).toHaveLength(1);
    expect(view.sounds()).toHaveLength(0);
    expect(view.report().counts.hearing).toBe(1);
  });

  it('treats a port that cannot report sound as silence, not as an error', () => {
    const clock = new ManualClock(1_000);
    const world = new FakeWorld();
    const sensors = new FakeSensorPort(world);
    const gate = new PerceptionGate(FAIR_PLAY, clock);
    // A SensorPort written before hearing existed has no drain at all.
    const deaf: SensorPort = {
      body: () => sensors.body(),
      blockAt: (position) => sensors.blockAt(position),
      entities: () => sensors.entities(),
      inventory: () => sensors.inventory(),
      equipment: () => sensors.equipment(),
      isOccluded: (from, to) => sensors.isOccluded(from, to),
      findBlocks: (options) => sensors.findBlocks(options),
    };
    const view = new PerceptionAdapter(
      deaf,
      gate,
      new WorldMemory(clock, { expiry: gate }),
    );

    expect(view.sounds()).toHaveLength(0);
    expect(view.report().total).toBe(0);
  });
});

describe('bearingOf', () => {
  const origin = vec3(0, 0, 0);
  const cases: ReadonlyArray<readonly [Vec3Like, string]> = [
    [vec3(0, 0, -10), 'N'],
    [vec3(10, 0, -10), 'NE'],
    [vec3(10, 0, 0), 'E'],
    [vec3(10, 0, 10), 'SE'],
    [vec3(0, 0, 10), 'S'],
    [vec3(-10, 0, 10), 'SW'],
    [vec3(-10, 0, 0), 'W'],
    [vec3(-10, 0, -10), 'NW'],
  ];

  it('rounds to the eight compass points, north being negative z', () => {
    for (const [to, expected] of cases) {
      expect(bearingOf(origin, to)).toBe(expected);
    }
  });

  it('answers north for a sound at the listener, having nothing better to say', () => {
    expect(bearingOf(origin, origin)).toBe('N');
  });
});
