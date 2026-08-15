import { describe, expect, it } from 'vitest';
import { placeBlock } from '../../../src/skills/library/building.js';
import { OK, at, block, harness, precondition, refuse } from './harness.js';

const UP = at(0, 1, 0);

function scene(extra: { readonly carrying?: number } = {}) {
  return harness({
    inventory: [{ name: 'cobblestone', count: extra.carrying ?? 4 }],
    blocks: [block('stone', at(1, 64, 0)), block('air', at(1, 65, 0), false)],
  });
}

describe('placeBlock precondition', () => {
  it('holds when the item, the support and the free space are all known', async () => {
    const h = scene();
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });
    expect(check.holds).toBe(true);
  });

  it('refuses an item that is not carried', async () => {
    const h = harness({
      blocks: [block('stone', at(1, 64, 0)), block('air', at(1, 65, 0), false)],
    });
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('no cobblestone');
  });

  it('refuses a support block it has never sensed', async () => {
    const h = harness({ inventory: [{ name: 'cobblestone', count: 4 }] });
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('out of sight');
  });

  it('refuses to build into a space it cannot sense', async () => {
    // The support is visible but the destination is not. Placing anyway would
    // risk overwriting something the agent has no business assuming is absent.
    const h = harness({
      inventory: [{ name: 'cobblestone', count: 4 }],
      blocks: [block('stone', at(1, 64, 0))],
    });
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('destination');
  });

  it('refuses an occupied destination', async () => {
    const h = harness({
      inventory: [{ name: 'cobblestone', count: 4 }],
      blocks: [block('stone', at(1, 64, 0)), block('dirt', at(1, 65, 0))],
    });
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('already occupied');
  });

  it('refuses a support that is not solid', async () => {
    const h = harness({
      inventory: [{ name: 'cobblestone', count: 4 }],
      blocks: [
        block('water', at(1, 64, 0), false),
        block('air', at(1, 65, 0), false),
      ],
    });
    const check = await precondition(placeBlock, h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('not solid');
  });
});

describe('placeBlock', () => {
  it('places against a face and confirms the result', async () => {
    const h = scene();
    const result = await placeBlock.run(h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toEqual(at(1, 65, 0));
    expect(result.value.confirmed).toBe(true);
    expect(h.world.countItem('cobblestone')).toBe(3);
  });

  it('fails world-changed when the support is mined first', async () => {
    const h = scene();
    h.world.setBlock(block('air', at(1, 64, 0), false));
    const result = await placeBlock.run(h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
    expect(h.body.calls).not.toContain('placeBlock');
  });

  it('fails unreachable when the destination is out of reach', async () => {
    const h = harness({
      inventory: [{ name: 'cobblestone', count: 4 }],
      blocks: [
        block('stone', at(30, 64, 0)),
        block('air', at(30, 65, 0), false),
      ],
    });
    const result = await placeBlock.run(h.ctx, {
      item: 'cobblestone',
      against: at(30, 64, 0),
      face: UP,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
  });

  it('does not believe a placement that left the space empty', async () => {
    const h = harness(
      {
        inventory: [{ name: 'cobblestone', count: 4 }],
        blocks: [
          block('stone', at(1, 64, 0)),
          block('air', at(1, 65, 0), false),
        ],
      },
      { placeBlock: () => OK },
    );
    const result = await placeBlock.run(h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('still air');
  });

  it('reports an actuator refusal', async () => {
    const h = harness(
      {
        inventory: [{ name: 'cobblestone', count: 4 }],
        blocks: [
          block('stone', at(1, 64, 0)),
          block('air', at(1, 65, 0), false),
        ],
      },
      { placeBlock: () => refuse('nothing to place against') },
    );
    const result = await placeBlock.run(h.ctx, {
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: UP,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('nothing to place against');
  });

  it('rejects a face that is not a unit offset', () => {
    const parsed = placeBlock.input.safeParse({
      item: 'cobblestone',
      against: at(1, 64, 0),
      face: at(1, 1, 0),
    });
    expect(parsed.success).toBe(false);
  });
});
