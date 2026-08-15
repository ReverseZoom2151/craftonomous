import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECONNECT,
  MAX_JOIN_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  MinecraftAuthError,
  backoffDelay,
  blockIsSolid,
  classifyEntity,
  extractXstsCode,
  normaliseEntityName,
  toAuthError,
} from '../../src/embodiment/mineflayer/index.js';

describe('classifyEntity', () => {
  it('treats anything with a username as a player', () => {
    expect(classifyEntity({ name: 'zombie', username: 'Notch' })).toEqual({
      kind: 'player',
      hostile: false,
    });
  });

  it('marks known hostiles hostile', () => {
    for (const name of ['zombie', 'creeper', 'skeleton', 'warden']) {
      expect(classifyEntity({ name })).toEqual({ kind: 'mob', hostile: true });
    }
  });

  it('treats neutrals as mobs that are not hostile', () => {
    expect(classifyEntity({ name: 'enderman' })).toEqual({
      kind: 'mob',
      hostile: false,
    });
    expect(classifyEntity({ name: 'wolf' })).toEqual({
      kind: 'mob',
      hostile: false,
    });
  });

  it('classifies passive creatures as animals', () => {
    expect(classifyEntity({ name: 'cow' })).toEqual({
      kind: 'animal',
      hostile: false,
    });
    expect(classifyEntity({ name: 'villager' })).toEqual({
      kind: 'animal',
      hostile: false,
    });
  });

  it('classifies dropped items and objects', () => {
    expect(classifyEntity({ name: 'item', type: 'object' }).kind).toBe('item');
    expect(classifyEntity({ name: 'arrow', type: 'projectile' }).kind).toBe(
      'object',
    );
  });

  it('falls back to the substrate type when the name is unknown', () => {
    expect(
      classifyEntity({ name: 'some_future_mob', type: 'hostile' }),
    ).toEqual({
      kind: 'mob',
      hostile: true,
    });
    expect(
      classifyEntity({ name: 'some_future_fish', type: 'water_creature' }).kind,
    ).toBe('animal');
    expect(classifyEntity({}).kind).toBe('other');
  });

  it('normalises namespaces and casing', () => {
    expect(normaliseEntityName('minecraft:Zombie')).toBe('zombie');
    expect(normaliseEntityName('Cave Spider')).toBe('cave_spider');
    expect(classifyEntity({ name: 'minecraft:Creeper' }).hostile).toBe(true);
  });
});

describe('blockIsSolid', () => {
  it('trusts the substrate bounding box when present', () => {
    expect(
      blockIsSolid({
        name: 'stone',
        position: { x: 0, y: 0, z: 0 },
        boundingBox: 'block',
      }),
    ).toBe(true);
    expect(
      blockIsSolid({
        name: 'water',
        position: { x: 0, y: 0, z: 0 },
        boundingBox: 'empty',
      }),
    ).toBe(false);
  });

  it('falls back to the name and treats missing blocks as clear', () => {
    expect(
      blockIsSolid({ name: 'stone', position: { x: 0, y: 0, z: 0 } }),
    ).toBe(true);
    expect(
      blockIsSolid({ name: 'cave_air', position: { x: 0, y: 0, z: 0 } }),
    ).toBe(false);
    expect(blockIsSolid(null)).toBe(false);
    expect(blockIsSolid(undefined)).toBe(false);
  });
});

describe('reconnect backoff', () => {
  it('never schedules a retry sooner than the join rate limit allows', () => {
    // Mojang allows 6 session joins per 30 seconds per account.
    const greedy = { ...DEFAULT_RECONNECT, initialDelayMs: 1, factor: 1 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(backoffDelay(attempt, greedy)).toBeGreaterThanOrEqual(
        MIN_RETRY_DELAY_MS,
      );
    }
  });

  it('cannot fit a full retry schedule inside one 30-second window', () => {
    let total = 0;
    for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS - 1; attempt += 1) {
      total += backoffDelay(attempt, DEFAULT_RECONNECT);
    }
    expect(total).toBeGreaterThan(30_000);
  });

  it('grows geometrically and then holds at the cap', () => {
    expect(backoffDelay(0, DEFAULT_RECONNECT)).toBe(5_000);
    expect(backoffDelay(1, DEFAULT_RECONNECT)).toBe(10_000);
    expect(backoffDelay(2, DEFAULT_RECONNECT)).toBe(20_000);
    expect(backoffDelay(9, DEFAULT_RECONNECT)).toBe(
      DEFAULT_RECONNECT.maxDelayMs,
    );
  });

  it('defaults to at most five joins, one under the limit', () => {
    expect(DEFAULT_RECONNECT.maxAttempts).toBe(5);
    expect(MAX_JOIN_ATTEMPTS).toBeLessThan(6);
  });
});

describe('authentication errors', () => {
  it('extracts an XSTS code from a prismarine-auth style message', () => {
    const error = new Error(
      'XSTS error: {"Identity":"0","XErr":2148916233,"Message":""}',
    );
    expect(extractXstsCode(error)).toBe(2148916233);
  });

  it('names the codes users actually hit', () => {
    const cases: ReadonlyArray<readonly [number, RegExp]> = [
      [2148916227, /banned/i],
      [2148916233, /xbox\.com/i],
      [2148916235, /region/i],
      [2148916238, /child account/i],
      [2148916236, /adult verification/i],
      [2148916237, /adult verification/i],
    ];
    for (const [code, expected] of cases) {
      const auth = toAuthError(new Error(`XErr: ${code}`));
      expect(auth).toBeInstanceOf(MinecraftAuthError);
      expect(auth?.code).toBe(code);
      expect(auth?.guidance).toMatch(expected);
    }
  });

  it('still names a generic authentication failure', () => {
    const auth = toAuthError(new Error('Invalid session token'));
    expect(auth).toBeInstanceOf(MinecraftAuthError);
    expect(auth?.code).toBeUndefined();
  });

  it('leaves non-authentication errors alone so they can be retried', () => {
    expect(
      toAuthError(new Error('ECONNREFUSED 127.0.0.1:25565')),
    ).toBeUndefined();
    expect(
      toAuthError(new Error('timed out after 60000ms waiting for spawn')),
    ).toBeUndefined();
  });
});
