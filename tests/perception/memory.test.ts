import { describe, expect, it } from 'vitest';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import { vec3 } from '../../src/embodiment/geometry.js';
import type { BlockInfo } from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import { observe } from '../../src/observation/observed.js';
import { PerceptionGate } from '../../src/perception/gate.js';
import { WorldMemory } from '../../src/perception/memory.js';
import { FAIR_PLAY, OMNISCIENT } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';

function sighting(
  name: string,
  position: Vec3Like,
  sensedAt: number,
): Observed<BlockInfo> {
  return observe({ name, position, solid: true }, 'sight', sensedAt);
}

describe('remember and recall', () => {
  it('recalls what was stored, re-tagged as memory with its age', () => {
    const clock = new ManualClock(1_000);
    const memory = new WorldMemory(clock);
    memory.remember(sighting('iron_ore', vec3(4, 64, 0), 1_000));

    clock.advance(2_500);
    const recalled = memory.recall(vec3(4, 64, 0));

    expect(recalled?.provenance).toBe('memory');
    expect(recalled?.value.name).toBe('iron_ore');
    expect(recalled?.sensedAt).toBe(1_000);
    expect(recalled?.age).toBe(2_500);
  });

  it('keys by block position, not by object identity', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(sighting('stone', vec3(4, 64, 0), 0));

    expect(memory.recall(vec3(4.7, 64.2, 0.9))?.value.name).toBe('stone');
  });

  it('replaces an older belief about the same position', () => {
    const clock = new ManualClock(0);
    const memory = new WorldMemory(clock);
    memory.remember(sighting('stone', vec3(4, 64, 0), 0));
    memory.remember(sighting('air', vec3(4, 64, 0), 500));

    expect(memory.size).toBe(1);
    expect(memory.recall(vec3(4, 64, 0))?.value.name).toBe('air');
  });

  it('knows nothing about a position never seen', () => {
    const memory = new WorldMemory(new ManualClock(0));
    expect(memory.recall(vec3(1, 1, 1))).toBeUndefined();
    expect(memory.has(vec3(1, 1, 1))).toBe(false);
  });

  it('forgets a position on request', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(sighting('stone', vec3(0, 0, 0), 0));

    expect(memory.forget(vec3(0, 0, 0))).toBe(true);
    expect(memory.forget(vec3(0, 0, 0))).toBe(false);
    expect(memory.size).toBe(0);
  });
});

describe('the memory horizon', () => {
  it('does not return a fact past the horizon', () => {
    const clock = new ManualClock(1_000);
    const gate = new PerceptionGate(FAIR_PLAY, clock);
    const memory = new WorldMemory(clock, { expiry: gate });
    memory.remember(sighting('iron_ore', vec3(4, 64, 0), 1_000));

    clock.advance(FAIR_PLAY.memoryHorizonMs);
    expect(memory.recall(vec3(4, 64, 0))).toBeDefined();

    clock.advance(1);
    expect(memory.recall(vec3(4, 64, 0))).toBeUndefined();
    expect(memory.all()).toHaveLength(0);
  });

  it('evicts expired entries on a sweep and reports how many went', () => {
    const clock = new ManualClock(0);
    const gate = new PerceptionGate(FAIR_PLAY, clock);
    const memory = new WorldMemory(clock);
    memory.remember(sighting('stone', vec3(0, 0, 0), 0));
    memory.remember(sighting('stone', vec3(1, 0, 0), 0));

    clock.advance(FAIR_PLAY.memoryHorizonMs + 1);
    memory.remember(sighting('stone', vec3(2, 0, 0), clock.now()));

    expect(memory.forgetExpired(gate)).toBe(2);
    expect(memory.size).toBe(1);
  });

  it('never forgets under an unbounded horizon', () => {
    const clock = new ManualClock(0);
    const gate = new PerceptionGate(OMNISCIENT, clock);
    const memory = new WorldMemory(clock, { expiry: gate });
    memory.remember(sighting('stone', vec3(0, 0, 0), 0));

    clock.advance(Number.MAX_SAFE_INTEGER);
    expect(memory.recall(vec3(0, 0, 0))).toBeDefined();
    expect(memory.forgetExpired(gate)).toBe(0);
  });

  it('sweeps nothing when no expiry rule was ever supplied', () => {
    const memory = new WorldMemory(new ManualClock(1_000_000));
    memory.remember(sighting('stone', vec3(0, 0, 0), 0));

    expect(memory.forgetExpired()).toBe(0);
    expect(memory.size).toBe(1);
  });
});

describe('bounded growth', () => {
  it('evicts the oldest-sensed entry once the cap is exceeded', () => {
    const clock = new ManualClock(0);
    const memory = new WorldMemory(clock, { maxEntries: 2 });
    memory.remember(sighting('a', vec3(0, 0, 0), 10));
    memory.remember(sighting('b', vec3(1, 0, 0), 20));
    memory.remember(sighting('c', vec3(2, 0, 0), 30));

    expect(memory.size).toBe(2);
    expect(memory.recall(vec3(0, 0, 0))).toBeUndefined();
    expect(memory.recall(vec3(1, 0, 0))?.value.name).toBe('b');
    expect(memory.recall(vec3(2, 0, 0))?.value.name).toBe('c');
  });

  it('holds the cap over a long run rather than growing without limit', () => {
    const clock = new ManualClock(0);
    const memory = new WorldMemory(clock, { maxEntries: 8 });
    for (let i = 0; i < 500; i += 1) {
      memory.remember(sighting('stone', vec3(i, 64, 0), i));
    }

    expect(memory.size).toBe(8);
    expect(memory.all()).toHaveLength(8);
    expect(memory.recall(vec3(499, 64, 0))?.value.name).toBe('stone');
  });

  it('evicts by sense time, not insertion order', () => {
    const memory = new WorldMemory(new ManualClock(0), { maxEntries: 2 });
    memory.remember(sighting('fresh', vec3(0, 0, 0), 100));
    memory.remember(sighting('stale', vec3(1, 0, 0), 1));
    memory.remember(sighting('newest', vec3(2, 0, 0), 200));

    expect(memory.recall(vec3(1, 0, 0))).toBeUndefined();
    expect(memory.recall(vec3(0, 0, 0))?.value.name).toBe('fresh');
  });

  it('refuses a nonsensical cap', () => {
    expect(() => new WorldMemory(new ManualClock(0), { maxEntries: 0 })).toThrow(RangeError);
  });
});

describe('all and clear', () => {
  it('lists every live observation as it was sensed', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(sighting('a', vec3(0, 0, 0), 0));
    memory.remember(sighting('b', vec3(1, 0, 0), 0));

    expect(memory.all()).toHaveLength(2);
    expect(memory.all().every((o) => o.provenance === 'sight')).toBe(true);
  });

  it('clears', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(sighting('a', vec3(0, 0, 0), 0));
    memory.clear();
    expect(memory.size).toBe(0);
  });
});
