/**
 * Live tests for the mineflayer binding.
 *
 * These need a real Minecraft server on the other end, so they are skipped
 * unless `CRAFTONOMOUS_LIVE=1` is set, and they are named `*.live-test.ts` so
 * the normal `vitest run` does not collect them at all. Nothing here runs in
 * ordinary CI.
 *
 *   docker compose -f docker/docker-compose.yml up -d
 *   CRAFTONOMOUS_LIVE=1 npx vitest run --config tests/live/vitest.config.ts
 *
 * The server is expected to be in offline mode. The suite connects once, in a
 * `beforeAll`, and reuses that one connection: Mojang allows six session joins
 * per thirty seconds per account, and a suite that joins per test is the exact
 * pattern that trips it the day somebody points this at a real account.
 *
 * See docs/LIVE_TESTING.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbodimentPort } from '../../src/embodiment/port.js';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import { connect } from '../../src/embodiment/mineflayer/binding.js';

const LIVE = process.env['CRAFTONOMOUS_LIVE'] === '1';

const HOST = process.env['MINECRAFT_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['MINECRAFT_PORT'] ?? '25565');
const USERNAME = process.env['MINECRAFT_USERNAME'] ?? 'livetest';
const VERSION = process.env['MINECRAFT_VERSION'];
const AUTH = process.env['MINECRAFT_AUTH'] ?? 'offline';

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe.skipIf(!LIVE)('live embodiment', () => {
  let body: EmbodimentPort;

  beforeAll(async () => {
    if (AUTH !== 'offline') {
      throw new Error(
        'the live suite refuses to run with MINECRAFT_AUTH other than "offline": ' +
          'repeated joins and failed sign-ins can suspend a Mojang account for a day',
      );
    }
    body = await connect({
      host: HOST,
      port: PORT,
      username: USERNAME,
      auth: 'offline',
      ...(VERSION === undefined || VERSION === '' ? {} : { version: VERSION }),
      spawnTimeoutMs: 60_000,
      // One attempt. The retry loop is a production concern, not a test one,
      // and its schedule is already covered by the offline backoff tests.
      reconnect: { enabled: false, maxAttempts: 1 },
    });
  });

  afterAll(async () => {
    await body?.disconnect();
  });

  it('reports a connected port after spawning', () => {
    expect(body.connected).toBe(true);
  });

  it('reports body state with plausible values', () => {
    const state = body.sensors.body();
    expect(Number.isFinite(state.position.x)).toBe(true);
    expect(Number.isFinite(state.position.y)).toBe(true);
    expect(Number.isFinite(state.position.z)).toBe(true);
    expect(state.position.y).toBeGreaterThan(-128);
    expect(state.position.y).toBeLessThan(512);
    expect(state.health).toBeGreaterThan(0);
    expect(state.health).toBeLessThanOrEqual(20);
    expect(state.food).toBeGreaterThanOrEqual(0);
    expect(state.food).toBeLessThanOrEqual(20);
    expect(state.dimension.length).toBeGreaterThan(0);
    // The eye is derived from the feet, so a drift here means the constant and
    // the position have come apart.
    expect(state.eyePosition.y - state.position.y).toBeCloseTo(1.62, 6);
  });

  it('reads the block it is standing on', () => {
    const state = body.sensors.body();
    const at = {
      x: Math.floor(state.position.x),
      y: Math.floor(state.position.y) - 1,
      z: Math.floor(state.position.z),
    };
    const block = body.sensors.blockAt(at);
    expect(block).toBeDefined();
    expect(block?.position).toEqual(at);
    expect(block?.name.length).toBeGreaterThan(0);
    expect(block?.solid).toBe(true);
  });

  it('reports unknown rather than guessing outside loaded chunks', () => {
    const state = body.sensors.body();
    const far = {
      x: Math.floor(state.position.x) + 4096,
      y: Math.floor(state.position.y),
      z: Math.floor(state.position.z) + 4096,
    };
    expect(body.sensors.blockAt(far)).toBeUndefined();
  });

  it('occludes sight into the ground and agrees with the block column', () => {
    const state = body.sensors.body();
    const eye = state.eyePosition;
    const x = Math.floor(state.position.x);
    const z = Math.floor(state.position.z);

    // For a vertical ray the blocks strictly between the endpoints are just the
    // column, so the expected answer can be computed without reusing the
    // traversal under test.
    const scan = (yFrom: number, yTo: number): boolean => {
      const low = Math.min(Math.floor(yFrom), Math.floor(yTo));
      const high = Math.max(Math.floor(yFrom), Math.floor(yTo));
      for (let y = low + 1; y < high; y += 1) {
        if (body.sensors.blockAt({ x, y, z })?.solid === true) return true;
      }
      return false;
    };

    const up = { x: eye.x, y: eye.y + 24, z: eye.z };
    const down = { x: eye.x, y: eye.y - 16, z: eye.z };

    expect(body.sensors.isOccluded(eye, down)).toBe(true);
    expect(body.sensors.isOccluded(eye, down)).toBe(scan(down.y, eye.y));
    expect(body.sensors.isOccluded(eye, up)).toBe(scan(eye.y, up.y));
    expect(body.sensors.isOccluded(eye, eye)).toBe(false);
  });

  it('does not report itself among the entities it can see', () => {
    const here = body.sensors.body().position;
    for (const entity of body.sensors.entities()) {
      expect(distance(entity.position, here)).toBeGreaterThan(1e-9);
    }
  });

  it('changes position when told to move', { timeout: 120_000 }, async () => {
    const before = body.sensors.body().position;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
    ];

    let moved = 0;
    for (const [dx, dz] of offsets) {
      const outcome = await body.actuators.moveTo(
        { x: before.x + dx, y: before.y, z: before.z + dz },
        { range: 1, signal: AbortSignal.timeout(25_000) },
      );
      moved = distance(before, body.sensors.body().position);
      if (outcome.ok && moved > 0.75) break;
    }
    await body.actuators.stop();

    // Every direction being blocked is possible in principle, so the failure
    // message matters more than usual here.
    expect(
      moved,
      'the bot did not move in any of the four directions tried',
    ).toBeGreaterThan(0.75);
  });

  it('disconnects cleanly and stays disconnected', async () => {
    await body.disconnect();
    expect(body.connected).toBe(false);
    // Idempotent: the teardown hook will call it again.
    await expect(body.disconnect()).resolves.toBeUndefined();
  });
});
