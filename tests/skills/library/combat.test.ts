import { describe, expect, it } from 'vitest';
import { attackEntity } from '../../../src/skills/library/combat.js';
import { OK, at, entity, harness, precondition, refuse } from './harness.js';

describe('attackEntity', () => {
  it('swings until the target stops being sensed', async () => {
    let swings = 0;
    const h = harness(
      {
        entities: [
          entity(9, 'zombie', at(2, 64, 0), { health: 20, hostile: true }),
        ],
      },
      {
        attack: () => {
          swings += 1;
          if (swings >= 3) h.world.entities = [];
          return OK;
        },
      },
    );
    const result = await attackEntity.run(h.ctx, { name: 'zombie' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defeated).toBe(true);
    expect(result.value.swings).toBe(3);
    expect(result.value.entityId).toBe(9);
  });

  it('stops as soon as the target reads zero health', async () => {
    const h = harness(
      { entities: [entity(9, 'zombie', at(2, 64, 0), { health: 4 })] },
      {
        attack: () => {
          h.world.entities = [entity(9, 'zombie', at(2, 64, 0), { health: 0 })];
          return OK;
        },
      },
    );
    const result = await attackEntity.run(h.ctx, { name: 'zombie' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.swings).toBe(1);
    expect(result.value.remainingHealth).toBe(0);
  });

  it('closes the distance before swinging', async () => {
    let swings = 0;
    const h = harness(
      { entities: [entity(2, 'skeleton', at(12, 64, 0), { health: 10 })] },
      {
        attack: () => {
          swings += 1;
          h.world.entities = [];
          return OK;
        },
      },
    );
    const result = await attackEntity.run(h.ctx, { name: 'skeleton' });

    expect(result.ok).toBe(true);
    expect(swings).toBe(1);
    expect(h.body.calls).toContain('moveTo');
  });

  it('fails its precondition when the target is not sensed', async () => {
    const h = harness({ entities: [entity(1, 'cow', at(2, 64, 0))] });
    const check = await precondition(attackEntity, h.ctx, { name: 'zombie' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('not sensed');
  });

  it('fails world-changed when the target leaves before the first swing', async () => {
    const h = harness({ entities: [entity(5, 'zombie', at(2, 64, 0))] });
    h.world.entities = [];
    const result = await attackEntity.run(h.ctx, { entityId: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('world-changed');
  });

  it('fails timeout when the target outlasts the swing budget', async () => {
    const h = harness({
      entities: [entity(9, 'iron_golem', at(2, 64, 0), { health: 100 })],
    });
    const result = await attackEntity.run(h.ctx, {
      name: 'iron_golem',
      maxSwings: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('survived 4 swings');
    expect(h.body.calls.filter((c) => c === 'attack')).toHaveLength(4);
  });

  it('fails unreachable when the target is far and approaching is forbidden', async () => {
    const h = harness({ entities: [entity(9, 'zombie', at(12, 64, 0))] });
    const result = await attackEntity.run(h.ctx, {
      name: 'zombie',
      approach: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(h.body.calls).toHaveLength(0);
  });

  it('fails unreachable when it cannot close in', async () => {
    const h = harness(
      { entities: [entity(9, 'zombie', at(12, 64, 0))] },
      { moveTo: () => refuse('across a ravine') },
    );
    const result = await attackEntity.run(h.ctx, { name: 'zombie' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.message).toContain('across a ravine');
  });

  it('breaks off mid-fight when a reflex cancels', async () => {
    const h = harness(
      { entities: [entity(9, 'zombie', at(2, 64, 0), { health: 20 })] },
      {
        attack: () => {
          h.controller.abort();
          return OK;
        },
      },
    );
    const result = await attackEntity.run(h.ctx, {
      name: 'zombie',
      maxSwings: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(result.message).toContain('after 1 swings');
  });

  it('rejects being given both a name and an id', () => {
    const parsed = attackEntity.input.safeParse({
      name: 'zombie',
      entityId: 3,
    });
    expect(parsed.success).toBe(false);
  });
});
