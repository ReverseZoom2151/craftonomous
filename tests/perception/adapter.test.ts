import { describe, expect, it } from 'vitest';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import { distance, key, vec3 } from '../../src/embodiment/geometry.js';
import type { SensorPort } from '../../src/embodiment/port.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../../src/embodiment/types.js';
import { PerceptionAdapter } from '../../src/perception/adapter.js';
import { PerceptionGate } from '../../src/perception/gate.js';
import { WorldMemory } from '../../src/perception/memory.js';
import { FAIR_PLAY, OMNISCIENT, XRAY } from '../../src/perception/profile.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';

const EYE = vec3(0, 65, 0);

function bodyAt(eye: Vec3Like): BodyState {
  return {
    position: vec3(eye.x, eye.y - 1.62, eye.z),
    eyePosition: eye,
    health: 20,
    food: 20,
    oxygen: 20,
    onGround: true,
    inWater: false,
    inLava: false,
    isBurning: false,
    yaw: 0,
    pitch: 0,
    dimension: 'overworld',
  };
}

function block(name: string, position: Vec3Like, solid = true): BlockInfo {
  return { name, position, solid };
}

/**
 * A hand-built SensorPort. Deliberately local to this file: the perception
 * layer must be testable without any embodiment implementation existing.
 */
class FakeSensors implements SensorPort {
  bodyState: BodyState = bodyAt(EYE);
  readonly blocks = new Map<string, BlockInfo>();
  entityList: EntityInfo[] = [];
  items: ItemStack[] = [];
  /** Block keys that sit behind solid matter from the agent's eyes. */
  readonly walled = new Set<string>();

  put(b: BlockInfo, options: { behindWall?: boolean } = {}): BlockInfo {
    this.blocks.set(key(b.position), b);
    if (options.behindWall === true) this.walled.add(key(b.position));
    return b;
  }

  wall(position: Vec3Like): void {
    this.walled.add(key(position));
  }

  clearWall(position: Vec3Like): void {
    this.walled.delete(key(position));
  }

  body(): BodyState {
    return this.bodyState;
  }

  blockAt(position: Vec3Like): BlockInfo | undefined {
    return this.blocks.get(key(position));
  }

  entities(): readonly EntityInfo[] {
    return this.entityList;
  }

  inventory(): readonly ItemStack[] {
    return this.items;
  }

  equipment(): Readonly<Record<string, ItemStack | undefined>> {
    return {};
  }

  isOccluded(_from: Vec3Like, to: Vec3Like): boolean {
    return this.walled.has(key(to));
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit: number;
  }): readonly BlockInfo[] {
    const eye = this.bodyState.eyePosition;
    return [...this.blocks.values()]
      .filter((b) => options.names.includes(b.name))
      .filter((b) => distance(eye, b.position) <= options.maxDistance)
      .sort((a, b) => distance(eye, a.position) - distance(eye, b.position))
      .slice(0, options.limit);
  }
}

function setup(
  profile: PerceptionProfile = FAIR_PLAY,
  options: {
    readonly start?: number;
    readonly maxEntries?: number;
    readonly container?: () => ContainerView | undefined;
  } = {},
) {
  const clock = new ManualClock(options.start ?? 1_000);
  const sensors = new FakeSensors();
  const gate = new PerceptionGate(profile, clock);
  const memory = new WorldMemory(clock, {
    expiry: gate,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  const view = new PerceptionAdapter(
    sensors,
    gate,
    memory,
    options.container === undefined ? {} : { containerSource: options.container },
  );
  return { clock, sensors, gate, memory, view } as const;
}

describe('proprioception', () => {
  it('always reports the body, tagged proprioception', () => {
    const { view } = setup();
    const observed = view.body();
    expect(observed.provenance).toBe('proprioception');
    expect(observed.value.eyePosition).toEqual(EYE);
  });

  it('always reports the inventory, tagged proprioception', () => {
    const { view, sensors } = setup();
    sensors.items = [{ name: 'oak_log', count: 3 }];
    const observed = view.inventory();
    expect(observed.provenance).toBe('proprioception');
    expect(observed.value).toHaveLength(1);
  });

  it('exposes the gate profile as the run identity', () => {
    const { view } = setup(XRAY);
    expect(view.profile).toBe(XRAY);
  });
});

describe('blockAt', () => {
  it('sight-tags a block in range with a clear line, and counts it', () => {
    const { view, sensors, clock } = setup();
    sensors.put(block('iron_ore', vec3(4, 64, 0)));

    const observed = view.blockAt(vec3(4, 64, 0));

    expect(observed?.provenance).toBe('sight');
    expect(observed?.value.name).toBe('iron_ore');
    expect(observed?.sensedAt).toBe(clock.now());
    expect(view.report().counts.sight).toBe(1);
  });

  it('does not return a block behind a wall under fair play', () => {
    const { view, sensors } = setup();
    sensors.put(block('diamond_ore', vec3(6, 60, 0)), { behindWall: true });

    expect(view.blockAt(vec3(6, 60, 0))).toBeUndefined();
    expect(view.report().total).toBe(0);
  });

  it('returns the same block behind the same wall under xray', () => {
    const { view, sensors } = setup(XRAY);
    sensors.put(block('diamond_ore', vec3(6, 60, 0)), { behindWall: true });

    const observed = view.blockAt(vec3(6, 60, 0));

    expect(observed?.provenance).toBe('sight');
    expect(observed?.value.name).toBe('diamond_ore');
  });

  it('falls back to memory, aged, once a seen block is occluded', () => {
    const { view, sensors, clock } = setup();
    const at = vec3(4, 64, 0);
    sensors.put(block('iron_ore', at));
    expect(view.blockAt(at)?.provenance).toBe('sight');

    clock.advance(5_000);
    sensors.wall(at);
    const observed = view.blockAt(at);

    expect(observed?.provenance).toBe('memory');
    expect(observed?.value.name).toBe('iron_ore');
    expect(observed?.sensedAt).toBe(1_000);
    expect((observed as { age: number } | undefined)?.age).toBe(5_000);
    expect(view.report().counts.memory).toBe(1);
  });

  it('returns nothing at all once the memory horizon has passed', () => {
    const { view, sensors, clock } = setup();
    const at = vec3(4, 64, 0);
    sensors.put(block('iron_ore', at));
    view.blockAt(at);

    clock.advance(FAIR_PLAY.memoryHorizonMs + 1);
    sensors.wall(at);

    expect(view.blockAt(at)).toBeUndefined();
    expect(view.report().counts.memory).toBe(0);
  });

  it('does not count a read that fell outside sight range', () => {
    const { view, sensors } = setup();
    sensors.put(block('iron_ore', vec3(500, 64, 0)));

    expect(view.blockAt(vec3(500, 64, 0))).toBeUndefined();
    expect(view.report().total).toBe(0);
  });

  it('reports unknown for a coordinate the substrate has not loaded', () => {
    const { view } = setup();
    expect(view.blockAt(vec3(1, 64, 1))).toBeUndefined();
  });
});

describe('nearbyEntities', () => {
  const cow = (id: number, position: Vec3Like): EntityInfo => ({
    id,
    name: 'cow',
    kind: 'animal',
    position,
  });

  it('returns sighted entities nearest first', () => {
    const { view, sensors } = setup();
    sensors.entityList = [
      cow(1, vec3(20, 65, 0)),
      cow(2, vec3(3, 65, 0)),
      cow(3, vec3(9, 65, 0)),
    ];

    const seen = view.nearbyEntities();

    expect(seen.map((o) => o.value.id)).toEqual([2, 3, 1]);
    expect(seen.every((o) => o.provenance === 'sight')).toBe(true);
    expect(view.report().counts.sight).toBe(3);
  });

  it('drops entities past sight range and past maxDistance', () => {
    const { view, sensors } = setup();
    sensors.entityList = [cow(1, vec3(3, 65, 0)), cow(2, vec3(400, 65, 0))];

    expect(view.nearbyEntities().map((o) => o.value.id)).toEqual([1]);
    expect(view.nearbyEntities({ maxDistance: 2 })).toHaveLength(0);
  });

  it('drops occluded entities under fair play but not under xray', () => {
    const hidden = vec3(5, 65, 0);
    const fair = setup();
    fair.sensors.entityList = [cow(1, hidden), cow(2, vec3(2, 65, 0))];
    fair.sensors.wall(hidden);
    expect(fair.view.nearbyEntities().map((o) => o.value.id)).toEqual([2]);

    const xray = setup(XRAY);
    xray.sensors.entityList = [cow(1, hidden), cow(2, vec3(2, 65, 0))];
    xray.sensors.wall(hidden);
    expect(xray.view.nearbyEntities().map((o) => o.value.id)).toEqual([2, 1]);
  });

  it('filters by kind', () => {
    const { view, sensors } = setup();
    sensors.entityList = [
      cow(1, vec3(2, 65, 0)),
      { id: 2, name: 'zombie', kind: 'mob', position: vec3(3, 65, 0), hostile: true },
    ];

    expect(view.nearbyEntities({ kinds: ['mob'] }).map((o) => o.value.id)).toEqual([2]);
  });
});

describe('findBlocks', () => {
  it('gates every candidate the sensors offer, nearest first', () => {
    const { view, sensors } = setup();
    sensors.put(block('iron_ore', vec3(12, 64, 0)));
    sensors.put(block('iron_ore', vec3(3, 64, 0)));
    sensors.put(block('iron_ore', vec3(7, 64, 0)), { behindWall: true });

    const found = view.findBlocks({ names: ['iron_ore'], maxDistance: 32 });

    expect(found.map((o) => o.value.position.x)).toEqual([3, 12]);
    expect(found.every((o) => o.provenance === 'sight')).toBe(true);
  });

  it('honours the limit', () => {
    const { view, sensors } = setup();
    sensors.put(block('stone', vec3(2, 64, 0)));
    sensors.put(block('stone', vec3(4, 64, 0)));
    sensors.put(block('stone', vec3(6, 64, 0)));

    expect(view.findBlocks({ names: ['stone'], maxDistance: 32, limit: 2 })).toHaveLength(2);
  });

  it('unions recollections in when a known block is no longer visible', () => {
    const { view, sensors, clock } = setup();
    const hidden = vec3(10, 64, 0);
    sensors.put(block('iron_ore', hidden));
    sensors.put(block('iron_ore', vec3(3, 64, 0)));
    view.findBlocks({ names: ['iron_ore'], maxDistance: 32 });

    clock.advance(2_000);
    sensors.wall(hidden);
    const found = view.findBlocks({ names: ['iron_ore'], maxDistance: 32 });

    expect(found).toHaveLength(2);
    expect(found[0]?.provenance).toBe('sight');
    expect(found[1]?.provenance).toBe('memory');
    expect(found[1]?.value.position).toEqual(hidden);
  });
});

describe('openContainer', () => {
  it('reports nothing when no container is open', () => {
    const { view } = setup();
    expect(view.openContainer()).toBeUndefined();
  });

  it('sight-tags the open container', () => {
    const chest: ContainerView = {
      kind: 'chest',
      position: vec3(2, 64, 0),
      contents: [{ name: 'coal', count: 8 }],
    };
    const { view } = setup(FAIR_PLAY, { container: () => chest });

    const observed = view.openContainer();

    expect(observed?.provenance).toBe('sight');
    expect(observed?.value.contents[0]?.name).toBe('coal');
  });
});

describe('recollections', () => {
  it('lists what is remembered but not currently sighted', () => {
    const { view, sensors, clock } = setup();
    const hidden = vec3(8, 64, 0);
    const plain = vec3(2, 64, 0);
    sensors.put(block('iron_ore', hidden));
    sensors.put(block('oak_log', plain));
    view.blockAt(hidden);
    view.blockAt(plain);

    clock.advance(1_500);
    sensors.wall(hidden);
    const recalled = view.recollections();

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.value.name).toBe('iron_ore');
    expect(recalled[0]?.provenance).toBe('memory');
  });

  it('drops recollections past the horizon', () => {
    const { view, sensors, clock } = setup();
    const hidden = vec3(8, 64, 0);
    sensors.put(block('iron_ore', hidden));
    view.blockAt(hidden);

    clock.advance(FAIR_PLAY.memoryHorizonMs + 1);
    sensors.wall(hidden);

    expect(view.recollections()).toHaveLength(0);
  });
});

describe('the ledger a run ships with', () => {
  it('reports fair play with a zero privileged share for a fair-play run', () => {
    const { view, sensors, clock } = setup();
    sensors.put(block('iron_ore', vec3(4, 64, 0)));
    sensors.entityList = [{ id: 1, name: 'cow', kind: 'animal', position: vec3(3, 65, 0) }];

    view.body();
    view.inventory();
    view.blockAt(vec3(4, 64, 0));
    view.nearbyEntities();
    clock.advance(1_000);
    sensors.wall(vec3(4, 64, 0));
    view.blockAt(vec3(4, 64, 0));

    const report = view.report();
    expect(report.fairPlay).toBe(true);
    expect(report.privileged).toBe(0);
    expect(report.privilegedShare).toBe(0);
    expect(report.counts.proprioception).toBe(2);
    expect(report.counts.sight).toBe(2);
    expect(report.counts.memory).toBe(1);
    expect(report.total).toBe(5);
  });

  it('an omniscient run still records what it read', () => {
    const { view, sensors } = setup(OMNISCIENT);
    sensors.put(block('diamond_ore', vec3(300, 12, 300)), { behindWall: true });

    expect(view.blockAt(vec3(300, 12, 300))?.provenance).toBe('sight');
    expect(view.report().counts.sight).toBe(1);
  });
});
