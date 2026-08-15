import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vec3 } from '../../src/embodiment/geometry.js';
import { observe } from '../../src/observation/observed.js';
import { WorldMemory } from '../../src/perception/memory.js';
import { applySnapshot, captureSnapshot } from '../../src/persistence/capture.js';
import {
  PersistenceError,
  SnapshotVersionError,
} from '../../src/persistence/errors.js';
import { FileStore } from '../../src/persistence/file-store.js';
import type { Snapshot } from '../../src/persistence/snapshot.js';
import { emptySnapshot, SCHEMA_VERSION } from '../../src/persistence/snapshot.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';

let directory: string;
let path: string;
const store = new FileStore();

beforeEach(async () => {
  // Everything happens under the OS temp directory: a test run must never
  // leave a snapshot in the repository working tree.
  directory = await mkdtemp(join(tmpdir(), 'craftonomous-persistence-'));
  path = join(directory, 'agent.snapshot.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function populated(): Snapshot {
  const memory = new WorldMemory(new ManualClock(0));
  memory.remember(
    observe(
      { name: 'iron_ore', position: vec3(12, 40, -7), solid: true, hardness: 3 },
      'sight',
      1_000,
    ),
  );
  memory.remember(
    observe(
      { name: 'chest', position: vec3(0, 64, 0), solid: true },
      'testimony',
      2_000,
    ),
  );

  const tracker = new ReliabilityTracker();
  for (let i = 0; i < 6; i += 1) {
    tracker.record('mine_iron', { succeeded: true, durationMs: 250 });
  }
  tracker.record('mine_iron', { succeeded: false, durationMs: 250 });

  return captureSnapshot(memory, tracker, { savedAt: 3_000 });
}

describe('FileStore round trip', () => {
  it('saves and loads a snapshot unchanged', async () => {
    const snapshot = populated();
    await store.save(path, snapshot);

    expect(await store.load(path)).toEqual(snapshot);
  });

  it('brings back memory with its original sense times after a restart', async () => {
    await store.save(path, populated());

    const loaded = await store.load(path);
    expect(loaded).toBeDefined();

    // A fresh process, hours later.
    const memory = new WorldMemory(new ManualClock(3_600_000));
    const tracker = new ReliabilityTracker();
    const result = applySnapshot(memory, tracker, loaded!);

    expect(result.observations).toBe(2);
    expect(result.attempts).toBe(7);

    const ore = memory.recall(vec3(12, 40, -7));
    expect(ore?.sensedAt).toBe(1_000);
    expect(ore?.age).toBe(3_599_000);
    expect(ore?.value.hardness).toBe(3);
    expect(tracker.stats('mine_iron').attempts).toBe(7);
    expect(tracker.stats('mine_iron').successes).toBe(6);
  });

  it('creates the containing directory if it is not there yet', async () => {
    const nested = join(directory, 'runs', 'run-1', 'state.json');
    await store.save(nested, emptySnapshot(1));
    expect((await store.load(nested))?.savedAt).toBe(1);
  });
});

describe('FileStore failure handling', () => {
  it('treats a missing file as an empty result, since first run is normal', async () => {
    expect(await store.load(join(directory, 'nothing-here.json'))).toBeUndefined();
  });

  it('reports malformed JSON with a message naming the file', async () => {
    await writeFile(path, '{ "version": 2, "memory": ', 'utf8');

    await expect(store.load(path)).rejects.toThrow(PersistenceError);
    await expect(store.load(path)).rejects.toThrow(path);
    await expect(store.load(path)).rejects.toThrow(/not valid JSON/);
  });

  it('reports an unreadable version with a message naming the file', async () => {
    await writeFile(
      path,
      JSON.stringify({ version: SCHEMA_VERSION + 7, savedAt: 0 }),
      'utf8',
    );

    await expect(store.load(path)).rejects.toThrow(SnapshotVersionError);
    await expect(store.load(path)).rejects.toThrow(path);
  });
});

describe('FileStore atomicity', () => {
  it('leaves no temporary file behind after a successful save', async () => {
    await store.save(path, populated());
    await store.save(path, populated());

    expect(await readdir(directory)).toEqual(['agent.snapshot.json']);
  });

  it('leaves the previous snapshot intact when a save fails', async () => {
    const good = populated();
    await store.save(path, good);

    // A snapshot that cannot be serialised stands in for any mid-save
    // failure. The invariant under test is the same either way: the file on
    // disk is either the old snapshot or the new one, never a half of one.
    const poisoned = { ...good, savedAt: 1n } as unknown as Snapshot;
    await expect(store.save(path, poisoned)).rejects.toThrow(PersistenceError);

    expect(await store.load(path)).toEqual(good);
    expect(await readdir(directory)).toEqual(['agent.snapshot.json']);
  });

  it('ignores a temporary file left by a crashed writer', async () => {
    const good = populated();
    await store.save(path, good);
    // What a process killed between opening and renaming would leave behind.
    await writeFile(
      join(directory, '.agent.snapshot.json.999.abc.tmp'),
      '{"version":2,"mem',
      'utf8',
    );

    expect(await store.load(path)).toEqual(good);
  });

  it('survives concurrent saves to the same path', async () => {
    const a = { ...emptySnapshot(1) };
    const b = { ...emptySnapshot(2) };
    await Promise.all([store.save(path, a), store.save(path, b)]);

    const loaded = await store.load(path);
    expect([1, 2]).toContain(loaded?.savedAt);
    expect(await readdir(directory)).toEqual(['agent.snapshot.json']);
  });

  it('rejects a nonsensical retry budget', () => {
    expect(() => new FileStore({ renameAttempts: 0 })).toThrow(RangeError);
  });
});
