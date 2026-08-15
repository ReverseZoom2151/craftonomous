import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  formatAge,
  provenanceTag,
} from '../../src/agent/observation-digest.js';
import { OMNISCIENT } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FakeWorld, block, defaultBody, entity, obs } from './support.js';

const MINUTE = 60_000;

function world(now = 10 * MINUTE): { world: FakeWorld; clock: ManualClock } {
  const clock = new ManualClock(now);
  return { world: new FakeWorld(clock), clock };
}

describe('provenance rendering', () => {
  it('marks a remembered fact as remembered, with its age', () => {
    const { world: w, clock } = world();
    w.remembered = [
      obs(
        block('iron_ore', { x: 12, y: 40, z: -3 }),
        'memory',
        clock.now() - 4 * MINUTE,
      ),
    ];

    const digest = buildDigest(w, clock.now());

    expect(digest.text).toContain(
      'iron_ore at (12,40,-3) [remembered 4m ago]',
    );
  });

  it('never presents a remembered block as a present fact', () => {
    const { world: w, clock } = world();
    w.remembered = [
      obs(
        block('diamond_ore', { x: 5, y: 12, z: 5 }),
        'memory',
        clock.now() - 90_000,
      ),
    ];

    const line = buildDigest(w, clock.now())
      .text.split('\n')
      .find((l) => l.startsWith('diamond_ore'));

    expect(line).toBeDefined();
    expect(line).toContain('[remembered');
    expect(line).not.toContain('[seen]');
  });

  it('distinguishes a sighted block from a remembered one', () => {
    const { world: w, clock } = world();
    w.blocks = [obs(block('oak_log', { x: 1, y: 64, z: 1 }), 'sight', clock.now())];
    w.remembered = [
      obs(block('oak_log', { x: 9, y: 64, z: 9 }), 'memory', clock.now() - MINUTE),
    ];

    const text = buildDigest(w, clock.now(), { blockNames: ['oak_log'] }).text;

    expect(text).toContain('oak_log at (1,64,1) [seen]');
    expect(text).toContain('oak_log at (9,64,9) [remembered 1m ago]');
  });

  it('shows an age on a sighted fact once it is stale', () => {
    const { world: w, clock } = world();
    w.blocks = [
      obs(block('stone', { x: 0, y: 60, z: 0 }), 'sight', clock.now() - 30_000),
    ];

    const text = buildDigest(w, clock.now(), { blockNames: ['stone'] }).text;

    expect(text).toContain('stone at (0,60,0) [seen 30s ago]');
  });

  it('warns the reader that remembered facts may be false', () => {
    const { world: w, clock } = world();
    expect(buildDigest(w, clock.now()).text).toContain(
      'Anything tagged [remembered] may no longer be true',
    );
  });

  it('tags every provenance kind distinctly', () => {
    const at = 1000;
    expect(provenanceTag(obs(1, 'proprioception', at), at)).toBe('[felt]');
    expect(provenanceTag(obs(1, 'sight', at), at)).toBe('[seen]');
    expect(provenanceTag(obs(1, 'hearing', at), at)).toBe('[heard]');
    expect(provenanceTag(obs(1, 'inference', at), at)).toBe('[inferred]');
    expect(provenanceTag(obs(1, 'testimony', at), at)).toBe('[told]');
    expect(provenanceTag(obs(1, 'privileged', at), at)).toBe('[privileged]');
    expect(provenanceTag(obs(1, 'memory', at - 5000), at)).toBe(
      '[remembered 5s ago]',
    );
  });

  it('formats ages coarsely', () => {
    expect(formatAge(0)).toBe('<1s');
    expect(formatAge(4500)).toBe('5s');
    expect(formatAge(4 * MINUTE)).toBe('4m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(-10)).toBe('<1s');
  });
});

describe('bounds', () => {
  it('caps entities and says how many were elided', () => {
    const { world: w, clock } = world();
    w.entities = Array.from({ length: 25 }, (_, i) =>
      obs(entity(i, 'zombie', { x: i, y: 64, z: 0 }), 'sight', clock.now()),
    );

    const digest = buildDigest(w, clock.now(), { maxEntities: 5 });

    expect(digest.entities).toHaveLength(5);
    expect(digest.elided.entities).toBe(20);
    expect(digest.text).toContain('== nearby entities (5 of 25) ==');
    expect(digest.text).toContain('… 20 more entities elided');
  });

  it('caps blocks and says how many were elided', () => {
    const { world: w, clock } = world();
    w.remembered = Array.from({ length: 30 }, (_, i) =>
      obs(
        block('cobblestone', { x: i, y: 10, z: 0 }),
        'memory',
        clock.now() - MINUTE,
      ),
    );

    const digest = buildDigest(w, clock.now(), { maxBlocks: 4 });

    expect(digest.blocks).toHaveLength(4);
    expect(digest.elided.blocks).toBe(26);
    expect(digest.text).toContain('… 26 more known blocks elided');
  });

  it('caps inventory listing', () => {
    const { world: w, clock } = world();
    w.items = Array.from({ length: 10 }, (_, i) => ({
      name: `item_${i}`,
      count: 1,
    }));

    const digest = buildDigest(w, clock.now(), { maxInventory: 3 });

    expect(digest.elided.inventory).toBe(7);
    expect(digest.text).toContain('… 7 more stacks elided');
  });

  it('stays bounded as the world grows without limit', () => {
    const { world: w, clock } = world();
    const small = buildDigest(w, clock.now()).text.length;

    w.entities = Array.from({ length: 500 }, (_, i) =>
      obs(entity(i, 'cow', { x: i, y: 64, z: 0 }), 'sight', clock.now()),
    );
    w.remembered = Array.from({ length: 500 }, (_, i) =>
      obs(block('stone', { x: i, y: 5, z: 0 }), 'memory', clock.now() - 1000),
    );
    const big = buildDigest(w, clock.now()).text.length;

    expect(big).toBeLessThan(small + 2000);
  });
});

describe('content', () => {
  it('reports body, inventory, profile and the perception tally', () => {
    const { world: w, clock } = world();
    w.bodyState = defaultBody({ health: 11, food: 7, position: { x: 3, y: 70, z: -8 } });
    w.items = [{ name: 'bread', count: 4 }];

    const text = buildDigest(w, clock.now()).text;

    expect(text).toContain('at (3,70,-8) in overworld');
    expect(text).toContain('health 11/20');
    expect(text).toContain('food 7/20');
    expect(text).toContain('4x bread');
    expect(text).toContain('fair-play: sight 64, line of sight required');
    expect(text).toContain('reads so far:');
  });

  it('describes an unlimited profile without printing Infinity', () => {
    const { world: w, clock } = world();
    w.profile = OMNISCIENT;

    const text = buildDigest(w, clock.now()).text;

    expect(text).toContain('omniscient: sight unlimited');
    expect(text).toContain('privileged reads allowed');
    expect(text).not.toContain('Infinity');
  });

  it('lists an open container', () => {
    const { world: w, clock } = world();
    w.container = obs(
      {
        kind: 'chest' as const,
        position: { x: 2, y: 64, z: 2 },
        contents: [{ name: 'iron_ingot', count: 6 }],
      },
      'sight',
      clock.now(),
    );

    const text = buildDigest(w, clock.now()).text;

    expect(text).toContain('== open chest at (2,64,2) [seen] ==');
    expect(text).toContain('6x iron_ingot');
  });

  it('says "none known" rather than implying emptiness is certainty', () => {
    const { world: w, clock } = world();
    const text = buildDigest(w, clock.now()).text;
    expect(text).toContain('none known');
    expect(text).toContain('none sensed');
  });
});
