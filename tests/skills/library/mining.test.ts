import { describe, expect, it } from 'vitest';
import { collectBlock, digBlock } from '../../../src/skills/library/mining.js';
import { OK, at, block, harness, precondition, refuse } from './harness.js';

describe('digBlock precondition', () => {
  it('refuses a coordinate the agent has never sensed', async () => {
    // The block may well be there. The agent does not know that, and treating
    // unknown as diggable would be an inference it has not earned.
    const h = harness();
    const check = await precondition(digBlock, h.ctx, {
      position: at(1, 64, 0),
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('out of sight');
  });

  it('refuses air', async () => {
    const h = harness({ blocks: [block('air', at(1, 64, 0), false)] });
    const check = await precondition(digBlock, h.ctx, {
      position: at(1, 64, 0),
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('air');
  });

  it('refuses a block that is not what the caller expected', async () => {
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const check = await precondition(digBlock, h.ctx, {
      position: at(1, 64, 0),
      expect: 'iron_ore',
    });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('sensed stone');
  });

  it('holds for a known solid block', async () => {
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const check = await precondition(digBlock, h.ctx, {
      position: at(1, 64, 0),
    });
    expect(check.holds).toBe(true);
  });
});

describe('digBlock', () => {
  it('breaks the block and counts what was picked up', async () => {
    const h = harness(
      { blocks: [block('iron_ore', at(1, 64, 0))] },
      { drops: { iron_ore: 'raw_iron' } },
    );
    const result = await digBlock.run(h.ctx, { position: at(1, 64, 0) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('iron_ore');
    expect(result.value.collected).toBe(1);
    expect(h.world.countItem('raw_iron')).toBe(1);
  });

  it('counts a drop-free break as a success', async () => {
    const h = harness(
      { blocks: [block('gravel', at(1, 64, 0))] },
      {
        dig: (position) => {
          h.world.setBlock(block('air', position, false));
          return OK;
        },
      },
    );
    const result = await digBlock.run(h.ctx, { position: at(1, 64, 0) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.collected).toBe(0);
  });

  it('fails world-changed when the block goes between the check and the swing', async () => {
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const check = await precondition(digBlock, h.ctx, {
      position: at(1, 64, 0),
    });
    expect(check.holds).toBe(true);

    h.world.setBlock(block('air', at(1, 64, 0), false));
    const result = await digBlock.run(h.ctx, { position: at(1, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
    expect(h.body.calls).not.toContain('dig');
  });

  it("fails unreachable when the block is out of arm's reach", async () => {
    const h = harness({ blocks: [block('stone', at(20, 64, 0))] });
    const result = await digBlock.run(h.ctx, { position: at(20, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(h.body.calls).not.toContain('dig');
  });

  it('does not believe a dig that left the block standing', async () => {
    const h = harness(
      { blocks: [block('bedrock', at(1, 64, 0))] },
      { dig: () => OK },
    );
    const result = await digBlock.run(h.ctx, { position: at(1, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('still there');
  });

  it('reports an actuator refusal', async () => {
    const h = harness(
      { blocks: [block('obsidian', at(1, 64, 0))] },
      { dig: () => refuse('no tool strong enough') },
    );
    const result = await digBlock.run(h.ctx, { position: at(1, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no tool strong enough');
  });
});

describe('collectBlock', () => {
  it('gathers the requested number, approaching each one', async () => {
    const h = harness({
      blocks: [
        block('oak_log', at(1, 64, 0)),
        block('oak_log', at(8, 64, 0)),
        block('oak_log', at(14, 64, 0)),
      ],
    });
    const result = await collectBlock.run(h.ctx, { name: 'oak_log', count: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dug).toBe(2);
    expect(result.value.collected).toBe(2);
    expect(h.world.countItem('oak_log')).toBe(2);
  });

  it('counts drops that are not named after the block', async () => {
    const h = harness(
      { blocks: [block('iron_ore', at(1, 64, 0))] },
      { drops: { iron_ore: 'raw_iron' } },
    );
    const result = await collectBlock.run(h.ctx, { name: 'iron_ore' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.collected).toBe(1);
    expect(h.world.countItem('raw_iron')).toBe(1);
  });

  it('returns a partial haul rather than failing', async () => {
    const h = harness({ blocks: [block('oak_log', at(1, 64, 0))] });
    const result = await collectBlock.run(h.ctx, { name: 'oak_log', count: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requested).toBe(5);
    expect(result.value.dug).toBe(1);
  });

  it('fails unreachable when nothing of that name has been sensed', async () => {
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const result = await collectBlock.run(h.ctx, { name: 'diamond_ore' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('has not been sensed');
    expect(h.body.calls).toHaveLength(0);
  });

  it('fails world-changed when every candidate is gone on arrival', async () => {
    const h = harness(
      { blocks: [block('oak_log', at(8, 64, 0))] },
      {
        moveTo: (position) => {
          h.world.moveBody(position);
          h.world.setBlock(block('air', at(8, 64, 0), false));
          return OK;
        },
      },
    );
    const result = await collectBlock.run(h.ctx, { name: 'oak_log', count: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
    expect(result.message).toContain('vanished');
  });

  it('stops mid-haul when the caller cancels', async () => {
    const h = harness(
      {
        blocks: [
          block('oak_log', at(1, 64, 0)),
          block('oak_log', at(2, 64, 0)),
        ],
      },
      {
        dig: (position) => {
          h.world.setBlock(block('air', position, false));
          h.world.give('oak_log', 1);
          h.controller.abort();
          return OK;
        },
      },
    );
    const result = await collectBlock.run(h.ctx, { name: 'oak_log', count: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(result.message).toContain('after digging 1 of 2');
  });
});
