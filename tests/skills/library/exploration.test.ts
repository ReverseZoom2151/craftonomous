import { describe, expect, it } from 'vitest';
import type { Vec3Like } from '../../../src/embodiment/geometry.js';
import { distance } from '../../../src/embodiment/geometry.js';
import type { BlockInfo } from '../../../src/embodiment/types.js';
import { explore } from '../../../src/skills/library/exploration.js';
import { CORE_SKILLS } from '../../../src/skills/library/index.js';
import { OK, at, block, harness, precondition, refuse } from './harness.js';

/**
 * A patch of known ground, so that the coverage probe has something to sense.
 *
 * A cell absent from the fake world is *unknown*, not air, which is exactly the
 * distinction this skill exists to shrink: the probe counts cells that went
 * from unknown to known, so the fixture has to supply real ground for it to
 * find.
 */
function ground(radius: number, y = 64): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      blocks.push(block('grass_block', { x, y, z }));
    }
  }
  return blocks;
}

describe('explore', () => {
  it('walks outward and reports the ground it covered', async () => {
    const h = harness({ blocks: ground(28) });
    const result = await explore.run(h.ctx, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.found).toBe(false);
    expect(result.value.legsMoved).toBeGreaterThan(0);
    expect(result.value.distanceTravelled).toBeGreaterThan(0);
    expect(result.value.newlyKnown).toBeGreaterThan(0);
    expect(result.value.origin).toEqual(at(0, 64, 0));
    expect(h.body.calls.filter((c) => c === 'moveTo').length).toBe(
      result.value.legs,
    );
  });

  it('produces an output its own schema accepts', async () => {
    const h = harness({ blocks: ground(28) });
    const result = await explore.run(h.ctx, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(explore.output.safeParse(result.value).success).toBe(true);
  });

  it('is registered in the core library under the name the rule policy uses', () => {
    expect(CORE_SKILLS.map((s) => s.name)).toContain('explore');
  });

  /* ---------------------------------------------------------------- */
  /* not oscillating                                                   */
  /* ---------------------------------------------------------------- */

  it('never walks to the same place twice and works outward', async () => {
    const targets: Vec3Like[] = [];
    const h = harness(
      { blocks: ground(28) },
      {
        moveTo: (position) => {
          targets.push(position);
          h.world.moveBody(position);
          return OK;
        },
      },
    );

    const result = await explore.run(h.ctx, { budget: 200, legLength: 16 });
    expect(result.ok).toBe(true);
    expect(targets.length).toBeGreaterThan(4);

    // Distinct targets: the failure mode this pattern exists to rule out is a
    // body bouncing between two spots and calling it exploration.
    const seen = new Set(
      targets.map((t) => `${t.x.toFixed(3)},${t.z.toFixed(3)}`),
    );
    expect(seen.size).toBe(targets.length);

    // And the pattern is outward: each ring of eight sits further from the
    // origin than the ring before it.
    const origin = at(0, 64, 0);
    const radii = targets.map((t) => distance(origin, t));
    for (let i = 8; i < radii.length; i += 1) {
      expect(radii[i]!).toBeGreaterThan(radii[i - 8]!);
    }
  });

  it('terminates on the distance budget rather than walking forever', async () => {
    const h = harness({ blocks: ground(28) });
    const result = await explore.run(h.ctx, { budget: 40, legLength: 16 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stoppedBecause).toBe('budget');
    expect(result.value.distanceTravelled).toBeLessThan(80);
  });

  /* ---------------------------------------------------------------- */
  /* finding, and not finding                                          */
  /* ---------------------------------------------------------------- */

  it('reports what it was looking for once it comes into range', async () => {
    const h = harness({
      blocks: [...ground(28), block('oak_log', at(20, 64, 0))],
    });
    const result = await explore.run(h.ctx, {
      lookingFor: 'oak_log',
      searchRadius: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.found).toBe(true);
    expect(result.value.foundAt).toEqual(at(20, 64, 0));
    expect(result.value.lookingFor).toBe('oak_log');
    expect(result.value.stoppedBecause).toBe('found');
    // It stopped as soon as it saw the thing rather than spending the budget.
    expect(result.value.legs).toBe(1);
  });

  it('accepts the looking_for spelling the rule policy emits', async () => {
    const h = harness({
      blocks: [...ground(28), block('oak_log', at(20, 64, 0))],
    });
    const result = await explore.run(h.ctx, {
      looking_for: 'oak_log',
      searchRadius: 8,
    });

    expect(explore.input.safeParse({ looking_for: 'oak_log' }).success).toBe(
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.found).toBe(true);
    expect(result.value.lookingFor).toBe('oak_log');
  });

  it('succeeds with found false when it looked properly and found nothing', async () => {
    // Exploring and finding nothing is an answer. Failing here would tell the
    // caller to retry the exploration, which is precisely the wrong remedy.
    const h = harness({ blocks: ground(28) });
    const result = await explore.run(h.ctx, {
      lookingFor: 'diamond_ore',
      searchRadius: 16,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.found).toBe(false);
    expect(result.value.foundAt).toBeUndefined();
    expect(result.value.legsMoved).toBeGreaterThan(0);
    expect(result.value.stoppedBecause).not.toBe('found');
  });

  /* ---------------------------------------------------------------- */
  /* failing rather than looping                                       */
  /* ---------------------------------------------------------------- */

  it('fails unreachable when the body cannot be moved at all', async () => {
    const h = harness(
      { blocks: ground(28) },
      { moveTo: () => refuse('walled in') },
    );
    const result = await explore.run(h.ctx, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('walled in');
  });

  it('gives up after a run of legs that went nowhere', async () => {
    let calls = 0;
    const h = harness(
      { blocks: ground(28) },
      {
        moveTo: (position) => {
          calls += 1;
          // The first leg works; everything after it stalls on the spot.
          if (calls > 1) return refuse('no path');
          h.world.moveBody(position);
          return OK;
        },
      },
    );

    const result = await explore.run(h.ctx, { budget: 500, legLength: 16 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stoppedBecause).toBe('stalled');
    expect(result.value.legsMoved).toBe(1);
    // Four legs at most: one that moved, three that did not.
    expect(result.value.legs).toBe(4);
  });

  it('counts a partial walk as progress even when the mover reports failure', async () => {
    // A pathfinder that gives up halfway still carried the body onto new
    // ground, and ground covered is the whole point of the skill.
    const h = harness(
      { blocks: ground(28) },
      {
        moveTo: (position) => {
          h.world.moveBody({
            x: position.x / 2,
            y: position.y,
            z: position.z / 2,
          });
          return refuse('gave up halfway');
        },
      },
    );

    const result = await explore.run(h.ctx, { budget: 40, legLength: 16 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.legsMoved).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- */
  /* cancellation                                                      */
  /* ---------------------------------------------------------------- */

  it('bails as interrupted when the caller has already cancelled', async () => {
    const h = harness({ blocks: ground(28) });
    h.controller.abort();
    const result = await explore.run(h.ctx, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(h.body.calls).not.toContain('moveTo');
  });

  it('stops between legs when a reflex pre-empts it', async () => {
    const h = harness(
      { blocks: ground(28) },
      {
        moveTo: (position) => {
          h.world.moveBody(position);
          h.controller.abort();
          return OK;
        },
      },
    );

    const result = await explore.run(h.ctx, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(h.body.calls.filter((c) => c === 'moveTo').length).toBe(1);
  });

  /* ---------------------------------------------------------------- */
  /* precondition                                                      */
  /* ---------------------------------------------------------------- */

  it('holds when there is no target to look for', async () => {
    const h = harness({ blocks: ground(28) });
    expect(await precondition(explore, h.ctx, {})).toEqual({ holds: true });
  });

  it('holds when the target is not known', async () => {
    const h = harness({ blocks: ground(28) });
    const check = await precondition(explore, h.ctx, { lookingFor: 'oak_log' });
    expect(check.holds).toBe(true);
  });

  it('refuses to explore for something already in plain sight', async () => {
    const h = harness({
      blocks: [...ground(28), block('oak_log', at(4, 64, 0))],
    });
    const check = await precondition(explore, h.ctx, { lookingFor: 'oak_log' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('already known');
  });

  it('hands back the location instead of failing when run anyway', async () => {
    // The precondition and the run can disagree because the world moves
    // between them; the useful answer is where the thing is.
    const h = harness({
      blocks: [...ground(28), block('oak_log', at(4, 64, 0))],
    });
    const result = await explore.run(h.ctx, { lookingFor: 'oak_log' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.found).toBe(true);
    expect(result.value.legs).toBe(0);
    expect(h.body.calls).not.toContain('moveTo');
  });
});
