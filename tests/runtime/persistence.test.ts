import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import type { Recalled } from '../../src/observation/observed.js';
import type { BlockInfo } from '../../src/embodiment/types.js';
import {
  SnapshotFormatError,
  SnapshotVersionError,
  emptySnapshot,
} from '../../src/persistence/index.js';
import type { Snapshot } from '../../src/persistence/index.js';
import type {
  LifecycleSource,
  OfflineSession,
  OfflineSessionOptions,
} from '../../src/runtime/bootstrap.js';
import {
  createOfflineSession,
  openOfflineSession,
} from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { MemoryLogger, silentLogger } from '../../src/runtime/logger.js';
import type { SnapshotStore } from '../../src/runtime/persistence.js';
import { fileSnapshotStore } from '../../src/runtime/persistence.js';
import type { SkillContext } from '../../src/skills/types.js';

/**
 * Persistence, wired into the session lifecycle.
 *
 * Every test here is offline and every file is under the OS temporary
 * directory, so the suite needs no server, no mineflayer and no state that
 * outlives it. What is under test is not the codec, which has its own suite,
 * but the join: whether a session loads before it is used, saves once it is
 * quiet, and refuses to write back the things it was told to forget.
 */

/** Where the memory blocks sit, and where the body goes to stop seeing them. */
const ORE = { x: 3, y: 64, z: 0 };
const STONE = { x: 4, y: 64, z: 0 };
/** Off the line of sight to the two above, so digging it occludes nothing. */
const DIG_TARGET = { x: 0, y: 64, z: 2 };
const FAR = { x: 900, y: 64, z: 900 };

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'craftonomous-persistence-'));
  path = join(dir, 'snapshot.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function worldWithBlocks(): FakeWorld {
  const world = new FakeWorld();
  world.setBlock(ORE, 'iron_ore', true);
  world.setBlock(STONE, 'stone', true);
  world.setBlock(DIG_TARGET, 'stone', true);
  return world;
}

/** A world where the remembered positions are far out of range. */
function emptyWorldFarAway(): FakeWorld {
  const world = new FakeWorld();
  world.setBody({
    position: FAR,
    eyePosition: { x: FAR.x, y: FAR.y + 1.6, z: FAR.z },
  });
  return world;
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

/**
 * Sight the blocks, then walk out of range of them.
 *
 * Both halves matter, exactly as in the reconnect suite: sighting fills memory,
 * and walking away is what makes those sightings recollections rather than
 * things still in plain view.
 */
function rememberThenWalkAway(world: FakeWorld, session: OfflineSession): void {
  session.world.findBlocks({ names: ['iron_ore', 'stone'], maxDistance: 32 });
  world.setBody({
    position: FAR,
    eyePosition: { x: FAR.x, y: FAR.y + 1.6, z: FAR.z },
  });
}

function persisted(
  store: SnapshotStore,
  extra: OfflineSessionOptions = {},
): Promise<OfflineSession> {
  return openOfflineSession({
    autoStart: false,
    ...extra,
    persistence: { store, ...(extra.persistence ?? {}) },
  });
}

async function readSnapshot(): Promise<Snapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}

interface Emitter extends LifecycleSource {
  emit(event: { kind: string; generation?: number }): void;
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
  };
}

describe('a session without a store is the session it always was', () => {
  it('offers no save, and writes nothing anywhere', async () => {
    const world = worldWithBlocks();
    const session = createOfflineSession({
      world,
      clock: new ManualClock(1000),
      autoStart: false,
    });

    expect(session.save).toBeUndefined();
    rememberThenWalkAway(world, session);
    expect(session.world.recollections().length).toBeGreaterThan(0);

    await session.close?.();

    expect(session.body.connected).toBe(false);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('refuses a store on the synchronous constructor rather than ignoring it', () => {
    expect(() =>
      createOfflineSession({ persistence: { store: fileSnapshotStore(path) } }),
    ).toThrow(/openOfflineSession/);
  });
});

describe('the first run', () => {
  it('starts clean when there is no file, and leaves one behind', async () => {
    const world = worldWithBlocks();
    const session = await persisted(fileSnapshotStore(path), {
      world,
      clock: new ManualClock(1000),
    });

    expect(session.world.recollections()).toHaveLength(0);
    rememberThenWalkAway(world, session);
    await session.close?.();

    const snapshot = await readSnapshot();
    expect(snapshot.memory.observations.length).toBeGreaterThan(0);
  });
});

describe('what one session sighted, the next one knows', () => {
  it('carries world memory across a restart with its true age intact', async () => {
    const world = worldWithBlocks();
    const first = await persisted(fileSnapshotStore(path), {
      world,
      clock: new ManualClock(1000),
    });
    rememberThenWalkAway(world, first);
    const before = first.world.recollections();
    expect(before.length).toBeGreaterThan(0);
    await first.close?.();

    // A minute later, in a process that has seen nothing itself.
    const second = await persisted(fileSnapshotStore(path), {
      world: emptyWorldFarAway(),
      clock: new ManualClock(61_000),
    });

    const after = second.world.recollections();
    expect(after.map((o) => o.value.name).sort()).toEqual(
      before.map((o) => o.value.name).sort(),
    );

    // The point of persisting `sensedAt` verbatim: a fact off the disk reports
    // the age it actually has, not the age of the read that produced it. A
    // restore that re-stamped this would turn a minute-old belief into a
    // present-tense sighting, which is the one thing this stack exists to
    // prevent.
    const ore = after.find((o) => o.value.name === 'iron_ore');
    expect(ore?.sensedAt).toBe(1000);
    expect(ore?.provenance).toBe('memory');
    expect((ore as Recalled<BlockInfo> | undefined)?.age).toBe(60_000);

    await second.close?.();
  });

  it('carries reliability evidence across a restart', async () => {
    const world = worldWithBlocks();
    const first = await persisted(fileSnapshotStore(path), {
      world,
      clock: new ManualClock(1000),
    });
    const result = await first.invoker.run(
      'digBlock',
      { position: DIG_TARGET, expect: 'stone' },
      ctxFor(first),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(first.reliability.stats('digBlock').attempts).toBe(1);
    await first.close?.();

    const second = await persisted(fileSnapshotStore(path), {
      world: emptyWorldFarAway(),
      clock: new ManualClock(61_000),
    });

    const stats = second.reliability.stats('digBlock');
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);

    await second.close?.();
  });
});

describe('a snapshot that will not load', () => {
  it('refuses to start by default, and leaves the file alone', async () => {
    await writeFile(path, '{ this is not json', 'utf8');

    await expect(
      persisted(fileSnapshotStore(path), { world: worldWithBlocks() }),
    ).rejects.toBeInstanceOf(SnapshotFormatError);

    // Refusing is only worth anything if the unreadable file survives to be
    // inspected. A session that started fresh would have overwritten this.
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });

  it('refuses a schema version it cannot read', async () => {
    await writeFile(
      path,
      JSON.stringify({ ...emptySnapshot(5), version: 99 }),
      'utf8',
    );

    await expect(
      persisted(fileSnapshotStore(path), { world: worldWithBlocks() }),
    ).rejects.toBeInstanceOf(SnapshotVersionError);
  });

  it('tears the half-built session down when it refuses', async () => {
    await writeFile(path, 'not json', 'utf8');
    const log = new MemoryLogger();

    await expect(
      persisted(fileSnapshotStore(path), { world: worldWithBlocks(), log }),
    ).rejects.toThrow();

    // No dangling body, and the refusal is on the record.
    expect(
      log.records.some(
        (r) => r.message === 'snapshot could not be read, refusing to start',
      ),
    ).toBe(true);
  });

  it('starts empty and says so loudly when told to discard', async () => {
    await writeFile(path, 'not json', 'utf8');
    const log = new MemoryLogger();

    const session = await openOfflineSession({
      world: worldWithBlocks(),
      clock: new ManualClock(1000),
      autoStart: false,
      log,
      persistence: { store: fileSnapshotStore(path), onCorrupt: 'discard' },
    });

    expect(session.world.recollections()).toHaveLength(0);
    const shouted = log.records.find(
      (r) => r.message === 'snapshot discarded, starting with an empty memory',
    );
    expect(shouted?.level).toBe('error');
    expect(shouted?.fields?.['store']).toBe(path);

    await session.close?.();
  });
});

describe('a persistence failure does not take the run down', () => {
  const exploding: SnapshotStore = {
    label: 'exploding-store',
    load: () => Promise.resolve(undefined),
    save: () =>
      Promise.reject(new Error('ENOSPC: no space left on device, write')),
  };

  it('reports a failed checkpoint instead of throwing', async () => {
    const log = new MemoryLogger();
    const session = await persisted(exploding, {
      world: worldWithBlocks(),
      clock: new ManualClock(1000),
      log,
    });

    const outcome = await session.save?.();
    expect(outcome?.saved).toBe(false);
    expect(outcome?.error).toMatch(/ENOSPC/);
    expect(
      log.records.some(
        (r) =>
          r.level === 'error' &&
          r.message === 'snapshot could not be saved, the run continues',
      ),
    ).toBe(true);

    // Still a working session afterwards.
    const result = await session.invoker.run(
      'digBlock',
      { position: DIG_TARGET, expect: 'stone' },
      ctxFor(session),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    await session.close?.();
  });

  it('closes cleanly even though the closing save fails', async () => {
    const session = await persisted(exploding, {
      world: worldWithBlocks(),
      clock: new ManualClock(1000),
    });

    await expect(session.close?.()).resolves.toBeUndefined();
    expect(session.body.connected).toBe(false);
  });
});

describe('a reconnect is not undone by the save that follows it', () => {
  it('writes the emptied memory, not the memory the reconnect cleared', async () => {
    const lifecycle = emitter();
    const world = worldWithBlocks();
    const first = await persisted(fileSnapshotStore(path), {
      world,
      clock: new ManualClock(1000),
      lifecycle,
    });

    // Evidence of two kinds: knowledge, which a reconnect invalidates, and a
    // skill's track record, which it does not.
    await first.invoker.run(
      'digBlock',
      { position: DIG_TARGET, expect: 'stone' },
      ctxFor(first),
    );
    rememberThenWalkAway(world, first);
    expect(first.world.recollections().length).toBeGreaterThan(0);

    lifecycle.emit({ kind: 'reconnected', generation: 2 });
    await first.close?.();

    const snapshot = await readSnapshot();
    // The whole point: forgetting has to survive the write, or the next
    // process starts confidently wrong about a world it never saw.
    expect(snapshot.memory.observations).toHaveLength(0);
    // Reliability is not invalidated by a dropped socket, so it stays.
    expect(snapshot.reliability.skills.map((s) => s.skill)).toContain(
      'digBlock',
    );

    const second = await persisted(fileSnapshotStore(path), {
      world: emptyWorldFarAway(),
      clock: new ManualClock(61_000),
    });
    expect(second.world.recollections()).toHaveLength(0);
    expect(second.reliability.stats('digBlock').attempts).toBe(1);
    await second.close?.();
  });

  it('does not checkpoint the cleared memory back from an in-flight save', async () => {
    const lifecycle = emitter();
    const world = worldWithBlocks();
    const session = await persisted(fileSnapshotStore(path), {
      world,
      clock: new ManualClock(1000),
      lifecycle,
    });
    rememberThenWalkAway(world, session);

    // A checkpoint taken before the reconnect, then the reconnect, then
    // another checkpoint. The second must overwrite the first.
    const first = await session.save?.();
    expect(first?.observations).toBeGreaterThan(0);

    lifecycle.emit({ kind: 'reconnected', generation: 2 });
    const after = await session.save?.();

    expect(after?.observations).toBe(0);
    expect((await readSnapshot()).memory.observations).toHaveLength(0);

    await session.close?.();
  });
});

describe('autosave', () => {
  it('checkpoints on an interval and stops when the session closes', async () => {
    let saves = 0;
    const counting: SnapshotStore = {
      label: 'counting-store',
      load: () => Promise.resolve(undefined),
      save: () => {
        saves += 1;
        return Promise.resolve();
      },
    };

    const world = worldWithBlocks();
    const session = await persisted(counting, {
      world,
      clock: new ManualClock(1000),
      persistence: { store: counting, autosaveIntervalMs: 5 },
    });
    rememberThenWalkAway(world, session);

    await delay(40);
    expect(saves).toBeGreaterThan(0);

    await session.close?.();
    const atClose = saves;

    // The timer is cleared on close, so nothing more is written. If it were
    // still running it would also still be holding a reference to a
    // disconnected body.
    await delay(40);
    expect(saves).toBe(atClose);
  });
});
