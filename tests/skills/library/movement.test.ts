import { describe, expect, it } from 'vitest';
import {
  flee,
  goToBlock,
  goToEntity,
  goToPosition,
  lookAt,
} from '../../../src/skills/library/movement.js';
import { OK, at, block, entity, harness, precondition, refuse } from './harness.js';

describe('goToPosition', () => {
  it('walks to the target and reports where the body ended up', async () => {
    const h = harness();
    const result = await goToPosition.run(h.ctx, { position: at(10, 64, 0) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alreadyThere).toBe(false);
    expect(result.value.distance).toBeCloseTo(0);
    expect(h.body.calls).toContain('moveTo');
  });

  it('does nothing when already inside the tolerance', async () => {
    const h = harness({ body: { position: at(3, 64, 0) } });
    const result = await goToPosition.run(h.ctx, { position: at(3, 64, 0.5), range: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alreadyThere).toBe(true);
    expect(h.body.calls).not.toContain('moveTo');
  });

  it('fails unreachable when the pathfinder gives up', async () => {
    const h = harness({}, { moveTo: () => refuse('no path') });
    const result = await goToPosition.run(h.ctx, { position: at(100, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('no path');
  });

  it('disbelieves a mover that claims success without arriving', async () => {
    // The realistic mineflayer failure: the pathfinder resolves at a doorway
    // it could not get through. The body, not the mover, is the authority.
    const h = harness({}, { moveTo: () => OK });
    const result = await goToPosition.run(h.ctx, { position: at(40, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('reported success');
  });

  it('bails as interrupted when the caller has already cancelled', async () => {
    const h = harness();
    h.controller.abort();
    const result = await goToPosition.run(h.ctx, { position: at(10, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(result.retryable).toBe(false);
    expect(h.body.calls).toHaveLength(0);
  });

  it('measures duration from the injected clock, not wall time', async () => {
    const slow = harness(
      {},
      {
        moveTo: (position) => {
          slow.world.clock.advance(750);
          slow.world.moveBody(position);
          return OK;
        },
      },
    );
    const result = await goToPosition.run(slow.ctx, { position: at(10, 64, 0) });

    // A manual clock that only moves inside the actuator: any use of
    // Date.now() would show up here as a non-750 duration.
    expect(result.durationMs).toBe(750);
  });
});

describe('goToBlock', () => {
  it('walks to the nearest known block of that name', async () => {
    const h = harness({
      blocks: [block('iron_ore', at(12, 64, 0)), block('iron_ore', at(4, 64, 0))],
    });
    const result = await goToBlock.run(h.ctx, { name: 'iron_ore' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toEqual(at(4, 64, 0));
    expect(result.value.provenance).toBe('sight');
  });

  it('treats a block it has never sensed as unknown, not absent', async () => {
    // The world contains diamond ore; the agent has simply not seen it. The
    // skill must not head off in a guessed direction.
    const h = harness({ blocks: [block('stone', at(1, 64, 0))] });
    const result = await goToBlock.run(h.ctx, { name: 'diamond_ore' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('has not been sensed');
    expect(h.body.calls).toHaveLength(0);
  });

  it('fails world-changed when the block is mined during the walk', async () => {
    // Someone else breaks it while we are walking.
    const h = harness(
      { blocks: [block('oak_log', at(6, 64, 0))] },
      {
        moveTo: (position) => {
          h.world.moveBody(position);
          h.world.setBlock(block('air', at(6, 64, 0), false));
          return OK;
        },
      },
    );
    const result = await goToBlock.run(h.ctx, { name: 'oak_log' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
    expect(result.message).toContain('air');
  });

  it('fails unreachable when the path to a known block does not exist', async () => {
    const h = harness(
      { blocks: [block('iron_ore', at(6, 64, 0))] },
      { moveTo: () => refuse('blocked by lava') },
    );
    const result = await goToBlock.run(h.ctx, { name: 'iron_ore' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('blocked by lava');
  });
});

describe('goToEntity', () => {
  it('approaches the nearest matching entity', async () => {
    const h = harness({
      entities: [entity(1, 'cow', at(9, 64, 0)), entity(2, 'cow', at(3, 64, 0))],
    });
    const result = await goToEntity.run(h.ctx, { name: 'cow' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entityId).toBe(2);
  });

  it('matches players by username', async () => {
    const h = harness({
      entities: [
        entity(7, 'player', at(5, 64, 0), { kind: 'player', username: 'Steve' }),
      ],
    });
    const check = await precondition(goToEntity, h.ctx, { name: 'steve' });
    expect(check.holds).toBe(true);
  });

  it('fails its precondition when no such entity is sensed', async () => {
    const h = harness({ entities: [entity(1, 'pig', at(3, 64, 0))] });
    const check = await precondition(goToEntity, h.ctx, { name: 'cow' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('cow');
  });

  it('fails world-changed when the entity leaves during the approach', async () => {
    const h = harness(
      { entities: [entity(4, 'zombie', at(8, 64, 0))] },
      {
        moveTo: (position) => {
          h.world.moveBody(position);
          h.world.entities = [];
          return OK;
        },
      },
    );
    const result = await goToEntity.run(h.ctx, { name: 'zombie' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
  });
});

describe('lookAt', () => {
  it('faces a position and reports the resulting orientation', async () => {
    const h = harness();
    const result = await lookAt.run(h.ctx, { position: at(4, 64, 0) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toEqual(at(4, 64, 0));
    expect(h.body.calls).toEqual(['lookAt']);
  });

  it('centres on the block when asked', async () => {
    const h = harness();
    const result = await lookAt.run(h.ctx, {
      position: at(4, 64, 0),
      centreOnBlock: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toEqual(at(4.5, 64.5, 0.5));
  });

  it('reports an actuator refusal rather than pretending it turned', async () => {
    const h = harness({}, { lookAt: () => refuse('head is locked') });
    const result = await lookAt.run(h.ctx, { position: at(4, 64, 0) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('head is locked');
  });
});

describe('flee', () => {
  it('retreats until the threat is far enough away', async () => {
    const h = harness();
    const result = await flee.run(h.ctx, { position: at(0, 64, 0), minDistance: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.moved).toBe(true);
    expect(result.value.distance).toBeGreaterThanOrEqual(10);
  });

  it('does not move when already clear', async () => {
    const h = harness({ body: { position: at(30, 64, 0) } });
    const result = await flee.run(h.ctx, { position: at(0, 64, 0), minDistance: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.moved).toBe(false);
    expect(h.body.calls).toHaveLength(0);
  });

  it('flees from a named entity', async () => {
    const h = harness({ entities: [entity(3, 'creeper', at(2, 64, 0))] });
    const result = await flee.run(h.ctx, { entityName: 'creeper', minDistance: 12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.distance).toBeGreaterThanOrEqual(12);
  });

  it('fails its precondition when the named entity is not sensed', async () => {
    const h = harness();
    const check = await precondition(flee, h.ctx, { entityName: 'creeper' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('nothing to flee');
  });

  it('fails unreachable when cornered', async () => {
    // The mover reports success but the body never gets clear: a dead end.
    const h = harness({}, { moveTo: () => OK });
    const result = await flee.run(h.ctx, { position: at(1, 64, 0), minDistance: 16 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('short of 16');
  });

  it('rejects being given both a position and an entity', () => {
    const parsed = flee.input.safeParse({
      position: at(0, 0, 0),
      entityName: 'creeper',
    });
    expect(parsed.success).toBe(false);
  });
});
