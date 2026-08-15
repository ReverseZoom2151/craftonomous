import { describe, expect, it } from 'vitest';
import {
  SnapshotFormatError,
  SnapshotVersionError,
} from '../../src/persistence/errors.js';
import {
  decodeSnapshot,
  emptySnapshot,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from '../../src/persistence/snapshot.js';

function current(): unknown {
  return {
    version: SCHEMA_VERSION,
    savedAt: 5_000,
    memory: {
      observations: [
        {
          block: { name: 'stone', position: { x: 1, y: 2, z: 3 }, solid: true },
          provenance: 'sight',
          sensedAt: 1_234,
        },
      ],
    },
    reliability: {
      skills: [
        {
          skill: 'mine_iron',
          attempts: 4,
          successes: 3,
          meanDurationMs: 12,
        },
      ],
    },
  };
}

describe('decodeSnapshot version handling', () => {
  it('accepts a snapshot written by this build', () => {
    const snapshot = decodeSnapshot(current(), 'test.json');
    expect(snapshot.version).toBe(SCHEMA_VERSION);
    expect(snapshot.savedAt).toBe(5_000);
    expect(snapshot.memory.observations).toHaveLength(1);
    expect(snapshot.reliability.skills).toHaveLength(1);
  });

  it('still loads an older supported version, with no reliability evidence', () => {
    // Version 1 predates reliability persistence. It must load, and it must
    // report no evidence rather than inventing any.
    const v1 = {
      version: MIN_SUPPORTED_SCHEMA_VERSION,
      savedAt: 10,
      memory: {
        observations: [
          {
            block: {
              name: 'oak_log',
              position: { x: -4, y: 70, z: 8 },
              solid: true,
            },
            provenance: 'memory',
            sensedAt: 7,
          },
        ],
      },
    };

    const snapshot = decodeSnapshot(v1, 'old.json');
    expect(snapshot.version).toBe(1);
    expect(snapshot.memory.observations[0]?.sensedAt).toBe(7);
    expect(snapshot.reliability.skills).toEqual([]);
  });

  it('refuses a future version with a message naming the file and versions', () => {
    const future = { ...(current() as object), version: SCHEMA_VERSION + 1 };
    let thrown: unknown;
    try {
      decodeSnapshot(future, 'future.json');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SnapshotVersionError);
    const error = thrown as SnapshotVersionError;
    expect(error.found).toBe(SCHEMA_VERSION + 1);
    expect(error.message).toContain('future.json');
    expect(error.message).toContain(String(SCHEMA_VERSION + 1));
    expect(error.message).toContain(String(SCHEMA_VERSION));
  });

  it('refuses a version older than anything it understands', () => {
    const ancient = { ...(current() as object), version: 0 };
    expect(() => decodeSnapshot(ancient, 'ancient.json')).toThrow(
      SnapshotVersionError,
    );
  });

  it('refuses a snapshot with no version at all', () => {
    const headless = { ...(current() as object) } as Record<string, unknown>;
    delete headless['version'];
    expect(() => decodeSnapshot(headless, 'headless.json')).toThrow(
      SnapshotFormatError,
    );
  });
});

describe('decodeSnapshot structural checks', () => {
  it('ignores unknown fields, so a richer writer degrades gracefully', () => {
    const richer = current() as Record<string, unknown>;
    richer['contexts'] = { nether: [] };
    const memory = richer['memory'] as {
      observations: Record<string, unknown>[];
    };
    memory.observations[0]!['confidence'] = 0.4;

    const snapshot = decodeSnapshot(richer, 'richer.json');
    expect(snapshot.memory.observations[0]?.block.name).toBe('stone');
    expect(snapshot.reliability.skills[0]?.attempts).toBe(4);
  });

  it('reads a missing section as empty rather than failing', () => {
    const bare = { version: SCHEMA_VERSION, savedAt: 1 };
    const snapshot = decodeSnapshot(bare, 'bare.json');
    expect(snapshot.memory.observations).toEqual([]);
    expect(snapshot.reliability.skills).toEqual([]);
  });

  it('rejects a wrongly typed sensedAt, naming where it is', () => {
    const broken = current() as Record<string, unknown>;
    const memory = broken['memory'] as {
      observations: Record<string, unknown>[];
    };
    memory.observations[0]!['sensedAt'] = 'yesterday';

    expect(() => decodeSnapshot(broken, 'broken.json')).toThrow(
      /memory\.observations\[0\]\.sensedAt/,
    );
  });

  it('rejects an unknown provenance rather than downgrading it silently', () => {
    const broken = current() as Record<string, unknown>;
    const memory = broken['memory'] as {
      observations: Record<string, unknown>[];
    };
    memory.observations[0]!['provenance'] = 'clairvoyance';

    expect(() => decodeSnapshot(broken, 'broken.json')).toThrow(
      SnapshotFormatError,
    );
  });

  it('rejects more successes than attempts', () => {
    const broken = current() as Record<string, unknown>;
    const reliability = broken['reliability'] as {
      skills: Record<string, unknown>[];
    };
    reliability.skills[0]!['successes'] = 99;

    expect(() => decodeSnapshot(broken, 'broken.json')).toThrow(
      /99 successes in 4 attempts/,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => decodeSnapshot([1, 2, 3], 'array.json')).toThrow(
      SnapshotFormatError,
    );
    expect(() => decodeSnapshot(null, 'null.json')).toThrow(
      SnapshotFormatError,
    );
  });
});

describe('emptySnapshot', () => {
  it('is the shape a first run legitimately has', () => {
    const snapshot = emptySnapshot(42);
    expect(snapshot).toEqual({
      version: SCHEMA_VERSION,
      savedAt: 42,
      memory: { observations: [] },
      reliability: { skills: [] },
    });
    expect(decodeSnapshot(JSON.parse(JSON.stringify(snapshot)), 'x')).toEqual(
      snapshot,
    );
  });
});
