import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import type { Provenance } from '../../src/observation/provenance.js';
import { PROVENANCE } from '../../src/observation/provenance.js';
import type { PerceptionReport } from '../../src/perception/ledger.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import { FAIR_PLAY, OMNISCIENT } from '../../src/perception/profile.js';
import type { WorldView } from '../../src/perception/world-view.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import type { Skill } from '../../src/skills/types.js';
import { succeed } from '../../src/skills/types.js';
import {
  RESOURCE_URIS,
  ResourceCatalog,
  UnknownResource,
  listResources,
} from '../../src/mcp/resources.js';
import { OfflineWorldView } from '../../src/mcp/offline.js';

const BODY: BodyState = {
  position: { x: 1, y: 64, z: 2 },
  eyePosition: { x: 1, y: 65.6, z: 2 },
  health: 18,
  food: 15,
  oxygen: 20,
  onGround: true,
  inWater: false,
  inLava: false,
  isBurning: false,
  yaw: 0,
  pitch: 0,
  dimension: 'overworld',
};

const COW: EntityInfo = {
  id: 7,
  name: 'cow',
  kind: 'animal',
  position: { x: 4, y: 64, z: 2 },
};

const REMEMBERED_ORE: BlockInfo = {
  name: 'iron_ore',
  position: { x: 10, y: 40, z: 10 },
  solid: true,
};

const CHEST: ContainerView = {
  kind: 'chest',
  position: { x: 3, y: 64, z: 3 },
  contents: [{ name: 'coal', count: 12 }],
};

function counts(overrides: Partial<Record<Provenance, number>> = {}) {
  const base = Object.fromEntries(PROVENANCE.map((p) => [p, 0])) as Record<
    Provenance,
    number
  >;
  return { ...base, ...overrides };
}

/** A world view with fixed answers and hand-set provenance. */
class FakeWorldView implements WorldView {
  constructor(readonly profile: PerceptionProfile = FAIR_PLAY) {}

  body(): Observed<BodyState> {
    return { value: BODY, provenance: 'proprioception', sensedAt: 1_000 };
  }

  inventory(): Observed<readonly ItemStack[]> {
    return {
      value: [
        { name: 'oak_log', count: 3, slot: 0 },
        { name: 'stone_pickaxe', count: 1, slot: 1 },
      ],
      provenance: 'proprioception',
      sensedAt: 1_000,
    };
  }

  blockAt(_position: Vec3Like): Observed<BlockInfo> | undefined {
    return undefined;
  }

  nearbyEntities(): readonly Observed<EntityInfo>[] {
    return [{ value: COW, provenance: 'sight', sensedAt: 1_200 }];
  }

  findBlocks(): readonly Observed<BlockInfo>[] {
    return [];
  }

  openContainer(): Observed<ContainerView> | undefined {
    return { value: CHEST, provenance: 'sight', sensedAt: 1_300 };
  }

  recollections(): readonly Observed<BlockInfo>[] {
    return [{ value: REMEMBERED_ORE, provenance: 'memory', sensedAt: 500 }];
  }

  report(): PerceptionReport {
    return {
      counts: counts({ proprioception: 4, sight: 12, memory: 3, privileged: 1 }),
      total: 20,
      privileged: 1,
      privilegedShare: 0.05,
      fairPlay: false,
    };
  }
}

function chopSkill(): Skill<never, unknown> {
  return {
    name: 'wood.chop',
    summary: 'Chop the nearest tree.',
    description: 'Fells one tree and collects the logs.',
    input: z.object({}),
    output: z.unknown(),
    timeoutMs: 60_000,
    run: async () => succeed(null, 0),
  } as unknown as Skill<never, unknown>;
}

function catalogue(world: WorldView = new FakeWorldView()): {
  catalog: ResourceCatalog;
  reliability: ReliabilityTracker;
} {
  const registry = new SkillRegistry();
  registry.register(chopSkill());
  const reliability = new ReliabilityTracker();
  reliability.record('wood.chop', { succeeded: true, durationMs: 1_000 });
  reliability.record('wood.chop', { succeeded: false, durationMs: 400 });
  return {
    catalog: new ResourceCatalog({ world, registry, reliability }),
    reliability,
  };
}

function read(catalog: ResourceCatalog, uri: string): Record<string, unknown> {
  const result = catalog.read(uri);
  const first = result.contents[0] as
    | { uri: string; mimeType?: string; text?: string }
    | undefined;
  expect(first?.mimeType).toBe('application/json');
  expect(first?.uri).toBe(uri);
  return JSON.parse(String(first?.text)) as Record<string, unknown>;
}

describe('the resource list', () => {
  it('advertises the five read-only views under the craftonomous scheme', () => {
    expect(listResources().map((r) => r.uri)).toEqual([
      'craftonomous://body',
      'craftonomous://inventory',
      'craftonomous://surroundings',
      'craftonomous://perception',
      'craftonomous://skills',
    ]);
    expect(listResources().every((r) => r.mimeType === 'application/json')).toBe(
      true,
    );
  });

  it('refuses a URI it does not serve', () => {
    const { catalog } = catalogue();
    expect(() => catalog.read('craftonomous://nether')).toThrow(UnknownResource);
  });
});

describe('craftonomous://body', () => {
  it('reports proprioception with its provenance', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.body);

    expect(json['profile']).toBe('fair-play');
    expect(json['body']).toEqual({
      value: BODY,
      provenance: 'proprioception',
      sensedAt: 1_000,
      fairPlay: true,
    });
  });
});

describe('craftonomous://inventory', () => {
  it('reports what is carried, with provenance and a total', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.inventory);
    const inventory = json['inventory'] as Record<string, unknown>;

    expect(inventory['provenance']).toBe('proprioception');
    expect(inventory['value']).toHaveLength(2);
    expect(json['totalItems']).toBe(4);
  });
});

describe('craftonomous://surroundings', () => {
  it('reports entities and known blocks, each carrying provenance', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.surroundings);

    const entities = json['entities'] as Record<string, unknown>[];
    expect(entities).toHaveLength(1);
    expect(entities[0]?.['provenance']).toBe('sight');
    expect(entities[0]?.['value']).toEqual(COW);

    const blocks = json['knownBlocks'] as Record<string, unknown>[];
    expect(blocks[0]?.['provenance']).toBe('memory');
    expect(blocks[0]?.['fairPlay']).toBe(true);

    const container = json['openContainer'] as Record<string, unknown>;
    expect(container['provenance']).toBe('sight');

    expect(json['sightRange']).toBe(FAIR_PLAY.sightRange);
    expect(json['requireLineOfSight']).toBe(true);
  });

  it('never hands over a bare fact: every entry says how it is known', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.surroundings);
    const everything = [
      ...(json['entities'] as Record<string, unknown>[]),
      ...(json['knownBlocks'] as Record<string, unknown>[]),
    ];
    expect(everything.length).toBeGreaterThan(0);
    for (const entry of everything) {
      expect(PROVENANCE).toContain(entry['provenance']);
      expect(typeof entry['sensedAt']).toBe('number');
      expect(typeof entry['fairPlay']).toBe('boolean');
    }
  });
});

describe('craftonomous://perception', () => {
  it('reports the profile, the per-provenance counts and the verdict', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.perception);

    expect(json['profile']).toMatchObject({
      name: 'fair-play',
      requireLineOfSight: true,
      allowPrivileged: false,
    });
    expect(json['counts']).toEqual(
      counts({ proprioception: 4, sight: 12, memory: 3, privileged: 1 }),
    );
    expect(json['total']).toBe(20);
    expect(json['privileged']).toBe(1);
    expect(json['privilegedShare']).toBeCloseTo(0.05);
    expect(json['fairPlay']).toBe(false);
  });

  it('names the profile a run is actually gated by', () => {
    const { catalog } = catalogue(new FakeWorldView(OMNISCIENT));
    const json = read(catalog, RESOURCE_URIS.perception);
    expect(json['profile']).toMatchObject({
      name: 'omniscient',
      allowPrivileged: true,
    });
  });
});

describe('craftonomous://skills', () => {
  it('lists skills with their measured reliability', () => {
    const { catalog } = catalogue();
    const json = read(catalog, RESOURCE_URIS.skills);

    expect(json['count']).toBe(1);
    const skills = json['skills'] as Record<string, unknown>[];
    const chop = skills[0];
    expect(chop?.['name']).toBe('wood.chop');
    expect(chop?.['summary']).toBe('Chop the nearest tree.');
    expect(chop?.['timeoutMs']).toBe(60_000);
    expect(chop?.['retired']).toBe(false);

    const reliability = chop?.['reliability'] as Record<string, number>;
    expect(reliability['attempts']).toBe(2);
    expect(reliability['successes']).toBe(1);
    expect(reliability['rate']).toBeCloseTo(0.5);
    // The Wilson bound, not the naive rate: two attempts is not evidence.
    expect(reliability['confidence']).toBeLessThan(0.5);
    expect(reliability['meanDurationMs']).toBe(700);
  });
});

describe('with no body bound', () => {
  it('says a read is unavailable instead of inventing world state', () => {
    const { catalog } = catalogue(new OfflineWorldView(FAIR_PLAY));

    const body = read(catalog, RESOURCE_URIS.body)['body'] as Record<
      string,
      unknown
    >;
    expect(body['available']).toBe(false);
    expect(String(body['reason'])).toContain('no Minecraft body is bound');

    const surroundings = read(catalog, RESOURCE_URIS.surroundings);
    expect(surroundings['entities']).toEqual([]);
    expect(surroundings['knownBlocks']).toEqual([]);
    expect(surroundings['openContainer']).toBeNull();

    // Zero reads is the truth offline, so the report says so rather than
    // claiming a fair-play run that never happened.
    const perception = read(catalog, RESOURCE_URIS.perception);
    expect(perception['total']).toBe(0);
  });
});
