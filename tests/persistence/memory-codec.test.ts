import { describe, expect, it } from 'vitest';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import { vec3 } from '../../src/embodiment/geometry.js';
import type { BlockInfo } from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import { observe } from '../../src/observation/observed.js';
import type { Provenance } from '../../src/observation/provenance.js';
import { WorldMemory } from '../../src/perception/memory.js';
import {
  restoreWorldMemory,
  snapshotWorldMemory,
} from '../../src/persistence/memory-codec.js';
import { ManualClock } from '../../src/runtime/clock.js';

function sighting(
  name: string,
  position: Vec3Like,
  sensedAt: number,
  provenance: Provenance = 'sight',
): Observed<BlockInfo> {
  return observe({ name, position, solid: true }, provenance, sensedAt);
}

describe('snapshotWorldMemory and restoreWorldMemory', () => {
  it('preserves the original sensedAt rather than restamping with now', () => {
    const clock = new ManualClock(1_000);
    const memory = new WorldMemory(clock);
    memory.remember(sighting('iron_ore', vec3(4, 64, 0), 1_000));

    const snapshot = snapshotWorldMemory(memory);

    // A restart hours later. If the restore stamped the current time, stale
    // belief would come back looking like a present-tense sighting.
    const laterClock = new ManualClock(9_999_000);
    const restored = new WorldMemory(laterClock);
    restoreWorldMemory(restored, snapshot);

    const recalled = restored.recall(vec3(4, 64, 0));
    expect(recalled?.sensedAt).toBe(1_000);
    expect(recalled?.age).toBe(9_998_000);
    expect(recalled?.provenance).toBe('memory');
  });

  it('preserves provenance for every kind of observation', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(sighting('stone', vec3(0, 0, 0), 10, 'sight'));
    memory.remember(sighting('chest', vec3(1, 0, 0), 20, 'testimony'));
    memory.remember(sighting('diamond_ore', vec3(2, 0, 0), 30, 'privileged'));
    memory.remember(sighting('dirt', vec3(3, 0, 0), 40, 'inference'));

    const snapshot = snapshotWorldMemory(memory);
    const byName = new Map(
      snapshot.observations.map((o) => [o.block.name, o.provenance]),
    );

    expect(byName.get('stone')).toBe('sight');
    expect(byName.get('chest')).toBe('testimony');
    expect(byName.get('diamond_ore')).toBe('privileged');
    expect(byName.get('dirt')).toBe('inference');
  });

  it('round trips optional block fields, keeping absent ones absent', () => {
    const memory = new WorldMemory(new ManualClock(0));
    memory.remember(
      observe(
        {
          name: 'torch',
          position: vec3(2, 65, 2),
          solid: false,
          lightLevel: 14,
          hardness: 0,
        },
        'sight',
        50,
      ),
    );
    memory.remember(sighting('stone', vec3(3, 65, 2), 60));

    const restored = new WorldMemory(new ManualClock(100));
    restoreWorldMemory(restored, snapshotWorldMemory(memory));

    const torch = restored.recall(vec3(2, 65, 2));
    expect(torch?.value.lightLevel).toBe(14);
    expect(torch?.value.hardness).toBe(0);
    expect(torch?.value.solid).toBe(false);

    const stone = restored.recall(vec3(3, 65, 2));
    expect(Object.hasOwn(stone!.value, 'lightLevel')).toBe(false);
  });

  it('caps persisted observations, evicting oldest-sensed first', () => {
    const memory = new WorldMemory(new ManualClock(0));
    for (let i = 0; i < 10; i += 1) {
      memory.remember(sighting(`block_${i}`, vec3(i, 64, 0), i * 100));
    }

    const snapshot = snapshotWorldMemory(memory, { maxObservations: 3 });

    expect(snapshot.observations).toHaveLength(3);
    expect(snapshot.observations.map((o) => o.block.name)).toEqual([
      'block_7',
      'block_8',
      'block_9',
    ]);
  });

  it('rejects a cap below one', () => {
    const memory = new WorldMemory(new ManualClock(0));
    expect(() => snapshotWorldMemory(memory, { maxObservations: 0 })).toThrow(
      RangeError,
    );
  });

  it('replays oldest first so a tighter in-memory cap keeps the freshest', () => {
    const memory = new WorldMemory(new ManualClock(0));
    for (let i = 0; i < 5; i += 1) {
      memory.remember(sighting(`block_${i}`, vec3(i, 64, 0), i * 100));
    }

    const restored = new WorldMemory(new ManualClock(1_000), { maxEntries: 2 });
    restoreWorldMemory(restored, snapshotWorldMemory(memory));

    expect(restored.size).toBe(2);
    expect(restored.recall(vec3(3, 64, 0))?.value.name).toBe('block_3');
    expect(restored.recall(vec3(4, 64, 0))?.value.name).toBe('block_4');
    expect(restored.recall(vec3(0, 64, 0))).toBeUndefined();
  });

  it('captures an empty memory as an empty snapshot', () => {
    const memory = new WorldMemory(new ManualClock(0));
    expect(snapshotWorldMemory(memory).observations).toEqual([]);
    expect(restoreWorldMemory(memory, { observations: [] })).toBe(0);
  });
});
