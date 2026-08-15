import { describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { MemoryLogger } from '../../src/runtime/logger.js';
import type { LifecycleSource } from '../../src/runtime/bootstrap.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';

/**
 * A reconnect invalidates knowledge and only the wiring layer can act on it.
 * These tests pin that behaviour, because the alternative failure is silent:
 * an agent carrying memories from a session that no longer exists is
 * confidently wrong, which is the one outcome the provenance work exists to
 * prevent.
 */

interface Emitter extends LifecycleSource {
  emit(event: { kind: string; generation?: number }): void;
  readonly listenerCount: number;
}

function emitter(): Emitter {
  const listeners = new Set<
    (e: { kind: string; generation?: number }) => void
  >();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const l of [...listeners]) l(event);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function sessionWithLifecycle(
  lifecycle: LifecycleSource,
  log = new MemoryLogger(),
) {
  const world = new FakeWorld();
  world.setBlock({ x: 3, y: 64, z: 0 }, 'iron_ore');
  world.setBlock({ x: 4, y: 64, z: 0 }, 'stone');
  const clock = new ManualClock(1000);
  const session = createOfflineSession({
    world,
    clock,
    log,
    lifecycle,
    autoStart: false,
  });
  return { session, world, clock, log };
}

/**
 * Sight the blocks, then walk far enough away that they are no longer in range.
 *
 * Both halves matter. Sighting fills memory, and moving away is what turns
 * those sightings into recollections, which is the state a reconnect must
 * destroy. Without the move the blocks would still be sighted and
 * `recollections()` would read empty for a reason unrelated to the thing under
 * test, so the assertion would pass while proving nothing.
 */
function rememberThenWalkAway(
  world: FakeWorld,
  view: {
    findBlocks: (o: {
      names: readonly string[];
      maxDistance: number;
    }) => unknown;
  },
): void {
  view.findBlocks({ names: ['iron_ore', 'stone'], maxDistance: 32 });
  world.setBody({
    position: { x: 900, y: 64, z: 900 },
    eyePosition: { x: 900, y: 65.6, z: 900 },
  });
}

describe('world memory across a reconnect', () => {
  it('forgets what it knew when the session generation changes', () => {
    const lifecycle = emitter();
    const { session, world } = sessionWithLifecycle(lifecycle);

    rememberThenWalkAway(world, session.world);
    // Non-vacuous: there must be something to lose before losing it means anything.
    expect(session.world.recollections().length).toBeGreaterThan(0);

    lifecycle.emit({ kind: 'reconnected', generation: 2 });

    // Nothing sighted in the previous session may be recalled in this one.
    expect(session.world.recollections()).toHaveLength(0);
  });

  it('leaves memory alone for lifecycle events that are not a reconnect', () => {
    const lifecycle = emitter();
    const { session, world } = sessionWithLifecycle(lifecycle);
    rememberThenWalkAway(world, session.world);
    const before = session.world.recollections().length;
    expect(before).toBeGreaterThan(0);

    lifecycle.emit({ kind: 'death' });
    lifecycle.emit({ kind: 'disconnected' });

    expect(session.world.recollections()).toHaveLength(before);
  });

  it('says what it forgot, so a run log explains the gap', () => {
    const lifecycle = emitter();
    const log = new MemoryLogger();
    const { session, world } = sessionWithLifecycle(lifecycle, log);
    rememberThenWalkAway(world, session.world);

    lifecycle.emit({ kind: 'reconnected', generation: 3 });

    const record = log.records.find(
      (r) => r.message === 'reconnected, world memory cleared',
    );
    expect(record).toBeDefined();
    expect(record?.fields?.['generation']).toBe(3);
  });

  it('unsubscribes on close, so a torn-down session stops listening', async () => {
    const lifecycle = emitter();
    const { session } = sessionWithLifecycle(lifecycle);
    expect(lifecycle.listenerCount).toBe(1);

    await session.close?.();

    expect(lifecycle.listenerCount).toBe(0);
  });

  it('assembles without a lifecycle at all', () => {
    // Nothing produces reconnect events on the live path yet, so a session
    // built without one must be entirely ordinary.
    const world = new FakeWorld();
    const session = createOfflineSession({ world, autoStart: false });
    expect(session.registry.size).toBeGreaterThan(0);
  });
});
