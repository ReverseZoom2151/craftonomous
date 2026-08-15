import { describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import type { SkillContext } from '../../src/skills/types.js';
import {
  createOfflineSession,
  type OfflineSession,
} from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * The reflex loop, which is what makes drowning protection reachable at all.
 *
 * The arbiter has always known that a body with two bubbles left should
 * surface. Until something ticked it, that knowledge was unreachable code, so
 * these tests are about the loop rather than about the reflexes themselves.
 */

const STONE = { x: 1, y: 64, z: 0 };

function drowningSession(): OfflineSession {
  const world = new FakeWorld();
  world.setBlock(STONE, 'stone', true);
  world.setBody({ inWater: true, oxygen: 2 });
  return createOfflineSession({
    world,
    clock: new ManualClock(1000),
    autoStart: false,
  });
}

function ctxFor(session: OfflineSession): SkillContext {
  return {
    world: session.world,
    act: session.act,
    clock: session.clock,
    log: silentLogger,
    signal: new AbortController().signal,
  };
}

describe('the supervisor fires reflexes', () => {
  it('does nothing while the body is fine', async () => {
    const session = createOfflineSession({ autoStart: false });
    expect(session.reflexes.tick()).toBeUndefined();
    expect(session.reflexes.fires).toHaveLength(0);
    expect(session.reflexes.firing).toBeUndefined();
    await session.close?.();
  });

  it('fires drowning and acts through the real actuators', async () => {
    const session = drowningSession();

    const fired = session.reflexes.tick();
    expect(fired?.name).toBe('drowning');
    // Firing is synchronous; the action is not, so it is still in flight here.
    expect(session.reflexes.firing?.name).toBe('drowning');

    await session.reflexes.settle();

    expect(session.reflexes.firing).toBeUndefined();
    expect(session.reflexes.fires).toHaveLength(1);
    expect(session.reflexes.fires[0]?.reflex).toBe('drowning');
    expect(session.reflexes.fires[0]?.at).toBe(1000);
    expect(session.reflexes.fires[0]?.error).toBeUndefined();

    const kinds = session.body.actuators.actions.map((a) => a.kind);
    expect(kinds).toContain('stop');
    expect(kinds).toContain('moveTo');
    // The reflex surfaced the body rather than merely announcing itself.
    expect(session.body.world.body().position.y).toBeGreaterThan(64);
  });

  it('pre-empts the running skill, which fails interrupted', async () => {
    const session = drowningSession();

    const pending = session.invoker.run(
      'digBlock',
      { position: STONE, expect: 'stone' },
      ctxFor(session),
    );
    // The run is registered synchronously, so a reflex arriving in the same
    // turn still catches it.
    expect(session.reflexes.guarding).toBe(1);

    session.reflexes.tick();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
    expect(session.reflexes.fires[0]?.preempted).toBe(1);
    // Pre-empted before the swing: the block is still there.
    expect(session.body.world.getBlock(STONE)?.name).toBe('stone');

    await session.reflexes.settle();
    expect(session.reflexes.guarding).toBe(0);
  });

  it('does not fire twice while its own action is running', async () => {
    const session = drowningSession();

    session.reflexes.tick();
    session.reflexes.tick();
    session.reflexes.tick();
    expect(session.reflexes.fires).toHaveLength(1);

    await session.reflexes.settle();

    // Still drowning once the action has finished, so it is allowed again.
    session.reflexes.tick();
    expect(session.reflexes.fires).toHaveLength(2);
    await session.reflexes.settle();
  });

  it('survives a tick that throws', async () => {
    const session = createOfflineSession({
      autoStart: false,
      reflexes: [
        {
          name: 'broken',
          priority: 1,
          shouldFire: () => {
            throw new Error('sensor exploded');
          },
          act: () => Promise.resolve(),
        },
      ],
    });

    expect(() => session.reflexes.tick()).not.toThrow();
    expect(session.reflexes.fires).toHaveLength(0);
    await session.close?.();
  });

  it('records a reflex action that failed without stopping the loop', async () => {
    const session = createOfflineSession({
      autoStart: false,
      clock: new ManualClock(7),
      reflexes: [
        {
          name: 'angry',
          priority: 1,
          shouldFire: () => true,
          act: () => Promise.reject(new Error('nope')),
        },
      ],
    });

    session.reflexes.tick();
    await session.reflexes.settle();

    expect(session.reflexes.fires).toEqual([
      { reflex: 'angry', at: 7, preempted: 0, error: 'nope' },
    ]);
    expect(session.reflexes.firing).toBeUndefined();
    await session.close?.();
  });
});

describe('the supervisor loop has a lifecycle', () => {
  it('starts by default and stops when the session closes', async () => {
    const session = createOfflineSession();
    expect(session.reflexes.started).toBe(true);

    await session.close?.();

    expect(session.reflexes.started).toBe(false);
    expect(session.body.connected).toBe(false);
  });

  it('starting twice does not start a second loop', async () => {
    const session = createOfflineSession({ autoStart: false });
    session.reflexes.start(5);
    session.reflexes.start(5);
    expect(session.reflexes.started).toBe(true);
    session.reflexes.stop();
    expect(session.reflexes.started).toBe(false);
    await session.close?.();
  });

  it('refuses a nonsensical interval', () => {
    const session = createOfflineSession({ autoStart: false });
    expect(() => session.reflexes.start(0)).toThrow(RangeError);
  });

  it('ticks on its own once started', async () => {
    const session = drowningSession();
    session.reflexes.start(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.reflexes.stop();
    await session.reflexes.settle();
    expect(session.reflexes.fires.length).toBeGreaterThan(0);
    await session.close?.();
  });
});
