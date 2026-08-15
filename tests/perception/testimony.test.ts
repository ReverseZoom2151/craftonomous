import { describe, expect, it } from 'vitest';

import { FakeWorld, FakeSensorPort } from '../../src/embodiment/fake/index.js';
import { vec3 } from '../../src/embodiment/geometry.js';
import { PerceptionAdapter } from '../../src/perception/adapter.js';
import { PerceptionGate } from '../../src/perception/gate.js';
import { WorldMemory } from '../../src/perception/memory.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import { TestimonyRegister, unverified } from '../../src/perception/testimony.js';
import { ManualClock } from '../../src/runtime/clock.js';

function setup() {
  const clock = new ManualClock(1_000);
  const world = new FakeWorld();
  world.setBody({ position: vec3(0, 64, 0), eyePosition: vec3(0, 65, 0) });
  const sensors = new FakeSensorPort(world);
  const gate = new PerceptionGate(FAIR_PLAY, clock);
  const memory = new WorldMemory(clock, { expiry: gate });
  const view = new PerceptionAdapter(sensors, gate, memory);
  return { clock, world, view } as const;
}

describe('chat as testimony', () => {
  it('tags a received message as testimony and counts it', () => {
    const { world, view, clock } = setup();
    world.emitChat('Alex', 'there is iron at 12 -54 88');

    const received = view.testimony();

    expect(received).toHaveLength(1);
    expect(received[0]?.provenance).toBe('testimony');
    expect(received[0]?.value.speaker).toBe('Alex');
    expect(received[0]?.value.text).toBe('there is iron at 12 -54 88');
    expect(received[0]?.sensedAt).toBe(clock.now());
    expect(view.report().counts.testimony).toBe(1);
  });

  it('arrives unverified, and stays testimony however plausible it turns out', () => {
    const { world, view } = setup();
    world.addEntity({
      id: 7,
      name: 'player',
      kind: 'player',
      position: vec3(3, 64, 0),
      username: 'Alex',
    });
    world.emitChat('Alex', 'stone right beside me');

    const claim = view.testimony()[0];
    expect(claim?.value.status).toBe('unverified');

    // Seeing Alex next to the claimed spot is the strongest support available.
    view.nearbyEntities();
    const checked = view.checkPositionClaim(claim!.value, vec3(4, 64, 0));

    expect(checked.status).toBe('speaker-could-have-known');
    // The observation carrying the claim is untouched, and testimony is never
    // promoted to sight by having been checked.
    expect(claim?.provenance).toBe('testimony');
    expect(claim?.value.status).toBe('unverified');
    expect(view.report().counts.sight).toBe(1);
  });

  it('hears the same claim twice as two separate pieces of testimony', () => {
    const { world, view } = setup();
    world.emitChat('Alex', 'iron here');
    view.testimony();
    world.emitChat('Alex', 'iron here');

    expect(view.testimony()).toHaveLength(1);
    expect(view.report().counts.testimony).toBe(2);
    // Drained, so a third read learns nothing new and counts nothing.
    expect(view.testimony()).toHaveLength(0);
    expect(view.report().counts.testimony).toBe(2);
  });

  it('keeps a whisper marked private', () => {
    const { world, view } = setup();
    world.emitChat('Steve', 'do not tell Alex', { private: true });
    expect(view.testimony()[0]?.value.private).toBe(true);
  });
});

describe('TestimonyRegister', () => {
  const claim = unverified({ from: 'Alex', text: 'diamonds down here', private: false });

  it('says nothing either way about a speaker it has never seen', () => {
    const register = new TestimonyRegister();
    const checked = register.checkPositionClaim(claim, vec3(0, 12, 0), 64);
    expect(checked.status).toBe('unverified');
    expect(checked.reason).toMatch(/never saw Alex/);
  });

  it('supports a claim when the speaker was seen within sensing range of it', () => {
    const register = new TestimonyRegister();
    register.noteSeen('Alex', vec3(0, 12, 10), 1_000);
    expect(register.checkPositionClaim(claim, vec3(0, 12, 0), 64).status).toBe(
      'speaker-could-have-known',
    );
  });

  it('reports an absence of support without calling the claim false', () => {
    const register = new TestimonyRegister();
    register.noteSeen('Alex', vec3(500, 64, 500), 1_000);
    const checked = register.checkPositionClaim(claim, vec3(0, 12, 0), 64);
    expect(checked.status).toBe('no-sighting-supports-it');
    expect(checked.reason).toMatch(/not evidence the claim is false/);
  });

  it('never upgrades a claim beyond a status and a reason', () => {
    const register = new TestimonyRegister();
    register.noteSeen('Alex', vec3(0, 12, 1), 1_000);
    const checked = register.checkPositionClaim(claim, vec3(0, 12, 0), 64);
    expect(checked.speaker).toBe(claim.speaker);
    expect(checked.text).toBe(claim.text);
    expect(Object.keys(checked).sort()).toEqual(
      ['private', 'reason', 'speaker', 'status', 'text'].sort(),
    );
  });

  it('bounds the sightings it keeps per speaker and the speakers it tracks', () => {
    const register = new TestimonyRegister({
      maxSightingsPerSpeaker: 3,
      maxSpeakers: 2,
    });
    for (let i = 0; i < 20; i += 1) {
      register.noteSeen('Alex', vec3(i, 64, 0), i);
    }
    expect(register.sightingsOf('Alex')).toHaveLength(3);
    expect(register.sightingsOf('Alex')[0]?.at).toBe(17);

    register.noteSeen('Steve', vec3(0, 64, 0), 100);
    register.noteSeen('Herobrine', vec3(0, 64, 0), 101);
    expect(register.sightingsOf('Alex')).toHaveLength(0);
    expect(register.sightingsOf('Steve')).toHaveLength(1);
    expect(register.sightingsOf('Herobrine')).toHaveLength(1);
  });

  it('forgets everything on clear, so one run cannot inform the next', () => {
    const register = new TestimonyRegister();
    register.noteSeen('Alex', vec3(0, 64, 0), 1_000);
    register.clear();
    expect(register.sightingsOf('Alex')).toHaveLength(0);
  });
});
