#!/usr/bin/env node
/**
 * Live smoke test: connect to a Minecraft server, sense, act, leave.
 *
 * This is the first thing to run against a real server. It exercises the parts
 * of the binding that no unit test can reach, in the order they break: the
 * connection, the spawn, the body state, block reads, occlusion, one real
 * movement, and a clean disconnect. It prints one line per check and exits
 * non-zero with a reason on the first failure.
 *
 * Plain ESM against the built binding in `dist/`, so running it needs only
 * `npm run build` and a server. Every wait is time-bounded, because a harness
 * that hangs forever tells you nothing at 3am.
 *
 * Safety: this script refuses to run with `MINECRAFT_AUTH=microsoft`. It makes
 * exactly one join attempt and never retries. Mojang allows six session joins
 * per thirty seconds per account, and a high volume of authentication errors
 * can suspend an account for about a day, so a smoke test that loops on real
 * credentials is a way to lose an account. Point this at the offline-mode
 * server in docker/docker-compose.yml.
 *
 *   node scripts/smoke.mjs
 *
 * Environment (same names the CLI uses):
 *   MINECRAFT_HOST      default 127.0.0.1
 *   MINECRAFT_PORT      default 25565
 *   MINECRAFT_USERNAME  default smoketest
 *   MINECRAFT_VERSION   optional; unset means auto-detect from the handshake
 *   MINECRAFT_AUTH      must be offline (or unset)
 *   SMOKE_TIMEOUT_MS    overall budget, default 180000
 */

import process from 'node:process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const BINDING_URL = new URL(
  '../dist/embodiment/mineflayer/binding.js',
  import.meta.url,
);

const HOST = process.env.MINECRAFT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MINECRAFT_PORT ?? '25565');
const USERNAME = process.env.MINECRAFT_USERNAME ?? 'smoketest';
const VERSION = process.env.MINECRAFT_VERSION;
const AUTH = process.env.MINECRAFT_AUTH ?? 'offline';
const TOTAL_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? '180000');

const SPAWN_TIMEOUT_MS = 60_000;
const MOVE_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 10_000;

/** Height of the eye above the feet, as the binding models it. */
const EYE_HEIGHT = 1.62;

let failures = 0;
let checks = 0;

function pass(name, detail) {
  checks += 1;
  console.log(`  ok    ${name}${detail === undefined ? '' : ` (${detail})`}`);
}

function fail(name, detail) {
  checks += 1;
  failures += 1;
  console.error(`  FAIL  ${name}: ${detail}`);
}

function note(line) {
  console.log(`        ${line}`);
}

/** Assert, but keep going so one run reports every broken thing, not the first. */
function check(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail ?? 'condition was false');
  return condition;
}

class Timeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Timeout(`${label} did not finish within ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
  });
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Whether the column strictly between two heights contains a solid block,
 * according to `blockAt` alone. For a vertical ray this is exactly what
 * `isOccluded` should report, which is what makes it a useful cross-check:
 * two independent paths through the substrate that must agree.
 */
function columnIsBlocked(sensors, x, z, yFrom, yTo) {
  const low = Math.min(Math.floor(yFrom), Math.floor(yTo));
  const high = Math.max(Math.floor(yFrom), Math.floor(yTo));
  let unknown = 0;
  for (let y = low + 1; y < high; y += 1) {
    const block = sensors.blockAt({ x, y, z });
    if (block === undefined) {
      unknown += 1;
      continue;
    }
    if (block.solid) return { blocked: true, unknown };
  }
  return { blocked: false, unknown };
}

async function main() {
  console.log('craftonomous smoke test');
  console.log(`  target ${HOST}:${PORT} as "${USERNAME}", auth ${AUTH}`);
  console.log(`  version ${VERSION ?? 'auto-detected from the handshake'}`);
  console.log('');

  if (AUTH !== 'offline') {
    throw new Error(
      'refusing to run: MINECRAFT_AUTH is not "offline". The smoke test never ' +
        'connects with real credentials, because repeated joins and failed ' +
        'sign-ins can get a Mojang account suspended. Bring up the offline-mode ' +
        'server in docker/docker-compose.yml instead.',
    );
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(
      `MINECRAFT_PORT is not a valid port: ${process.env.MINECRAFT_PORT}`,
    );
  }
  if (!existsSync(fileURLToPath(BINDING_URL))) {
    throw new Error(
      `the built binding is missing at ${fileURLToPath(BINDING_URL)}. Run "npm run build" first.`,
    );
  }

  const { connect } = await import(BINDING_URL.href);

  // --- 1. Connect and spawn -----------------------------------------------
  const startedAt = Date.now();
  let body;
  try {
    body = await withTimeout(
      connect({
        host: HOST,
        port: PORT,
        username: USERNAME,
        auth: 'offline',
        ...(VERSION === undefined || VERSION === ''
          ? {}
          : { version: VERSION }),
        spawnTimeoutMs: SPAWN_TIMEOUT_MS,
        // Exactly one attempt. No reconnect loop lives in this harness.
        reconnect: { enabled: false, maxAttempts: 1 },
      }),
      SPAWN_TIMEOUT_MS + 15_000,
      'connect',
    );
  } catch (error) {
    fail('connect and spawn', describe(error));
    return;
  }
  pass('connect and spawn', `${Date.now() - startedAt}ms`);
  check(
    'port reports connected',
    body.connected === true,
    'connected was false after spawn',
  );

  const { sensors, actuators } = body;

  try {
    // --- 2. Body state ----------------------------------------------------
    const state = sensors.body();
    note(
      `body at ${state.position.x.toFixed(2)}, ${state.position.y.toFixed(2)}, ` +
        `${state.position.z.toFixed(2)} in ${state.dimension}; health ${state.health}, food ${state.food}`,
    );
    check(
      'position is finite',
      finite(state.position.x) &&
        finite(state.position.y) &&
        finite(state.position.z),
      `got ${JSON.stringify(state.position)}`,
    );
    check(
      'position is inside the world height range',
      state.position.y > -128 && state.position.y < 512,
      `y was ${state.position.y}`,
    );
    check(
      'health is a live value',
      state.health > 0 && state.health <= 20,
      `health was ${state.health}`,
    );
    check(
      'food is in range',
      state.food >= 0 && state.food <= 20,
      `food was ${state.food}`,
    );
    check(
      'oxygen is in range',
      state.oxygen >= 0 && state.oxygen <= 20,
      `oxygen was ${state.oxygen}`,
    );
    check(
      'eye is one head above the feet',
      Math.abs(state.eyePosition.y - state.position.y - EYE_HEIGHT) < 1e-6,
      `feet y ${state.position.y}, eye y ${state.eyePosition.y}`,
    );
    check(
      'dimension is named',
      typeof state.dimension === 'string' && state.dimension.length > 0,
      `dimension was ${String(state.dimension)}`,
    );
    check(
      'yaw and pitch are finite',
      finite(state.yaw) && finite(state.pitch),
      `yaw ${state.yaw}, pitch ${state.pitch}`,
    );
    if (!state.onGround) {
      note(
        'warning: the bot is not on the ground yet; it may still be falling into the world',
      );
    }

    // --- 3. Block reads ---------------------------------------------------
    const feet = {
      x: Math.floor(state.position.x),
      y: Math.floor(state.position.y),
      z: Math.floor(state.position.z),
    };
    const below = sensors.blockAt({ x: feet.x, y: feet.y - 1, z: feet.z });
    if (
      check(
        'block below the feet is readable',
        below !== undefined,
        'blockAt returned undefined, which means the chunk is not loaded yet',
      )
    ) {
      note(`standing on ${below.name}`);
      check(
        'block position is the integer cell asked for',
        below.position.x === feet.x &&
          below.position.y === feet.y - 1 &&
          below.position.z === feet.z,
        `asked for ${feet.x},${feet.y - 1},${feet.z}, got ${JSON.stringify(below.position)}`,
      );
      check(
        'block below the feet is solid',
        below.solid === true,
        `${below.name} reported solid=${String(below.solid)}; the bot may have spawned over water or a cave`,
      );
    }

    const atEye = sensors.blockAt({ x: feet.x, y: feet.y + 1, z: feet.z });
    check(
      'block at head height is readable',
      atEye !== undefined,
      'blockAt returned undefined at head height',
    );
    if (atEye !== undefined && atEye.solid) {
      note(
        `warning: head height reads ${atEye.name}, which is solid; the bot is inside something`,
      );
    }

    // A block far outside any loaded chunk must read as unknown rather than as
    // an invented value. Getting a BlockInfo back here would mean the sensor is
    // guessing, which is the one failure mode the perception budget cannot
    // survive.
    const faraway = sensors.blockAt({
      x: feet.x + 4096,
      y: feet.y,
      z: feet.z + 4096,
    });
    check(
      'unloaded blocks read as unknown',
      faraway === undefined,
      `expected undefined far outside loaded chunks, got ${JSON.stringify(faraway)}`,
    );

    // --- 4. Occlusion -----------------------------------------------------
    // Two vertical rays from the eye, each cross-checked against a plain column
    // scan. Vertical is deliberate: for a vertical ray the set of blocks
    // strictly between the endpoints is just the column, so the expected answer
    // can be computed without reimplementing the traversal being tested.
    const eye = state.eyePosition;
    const up = { x: eye.x, y: eye.y + 24, z: eye.z };
    const down = { x: eye.x, y: eye.y - 16, z: eye.z };

    const upScan = columnIsBlocked(sensors, feet.x, feet.z, eye.y, up.y);
    const downScan = columnIsBlocked(sensors, feet.x, feet.z, down.y, eye.y);
    const upOccluded = sensors.isOccluded(eye, up);
    const downOccluded = sensors.isOccluded(eye, down);

    note(
      `looking up: ${upOccluded ? 'occluded' : 'clear'} (column scan says ` +
        `${upScan.blocked ? 'blocked' : 'clear'}); looking down: ` +
        `${downOccluded ? 'occluded' : 'clear'} (column scan says ${downScan.blocked ? 'blocked' : 'clear'})`,
    );
    check(
      'occlusion upward agrees with the block column',
      upOccluded === upScan.blocked,
      `isOccluded said ${upOccluded}, scanning the column said ${upScan.blocked}`,
    );
    check(
      'occlusion downward agrees with the block column',
      downOccluded === downScan.blocked,
      `isOccluded said ${downOccluded}, scanning the column said ${downScan.blocked}`,
    );
    check(
      'sight into the ground is occluded',
      downOccluded === true,
      'a ray from the eye into the ground came back clear, so occlusion is not being applied',
    );
    if (upOccluded) {
      note(
        'note: the sky is not visible from here, so the open-air case was not exercised',
      );
    }
    check(
      'a zero-length ray is not occluded',
      sensors.isOccluded(eye, eye) === false,
      'a ray to the eye position itself reported occlusion',
    );

    // --- 5. Movement ------------------------------------------------------
    // Try a few directions: the first one may be into a wall, and a bot that
    // cannot path north is not a broken binding.
    const before = sensors.body().position;
    const offsets = [
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
      [2, 2],
      [-2, -2],
    ];
    let moved = 0;
    let lastDetail = 'no direction was attempted';
    for (const [dx, dz] of offsets) {
      const target = { x: before.x + dx, y: before.y, z: before.z + dz };
      let outcome;
      try {
        outcome = await withTimeout(
          actuators.moveTo(target, {
            range: 1,
            signal: globalThis.AbortSignal.timeout(MOVE_TIMEOUT_MS),
          }),
          MOVE_TIMEOUT_MS + 5_000,
          'moveTo',
        );
      } catch (error) {
        lastDetail = describe(error);
        break;
      }
      moved = distance(before, sensors.body().position);
      if (outcome.ok && moved > 0.75) break;
      lastDetail = outcome.ok
        ? `pathfinder reported success but the body moved ${moved.toFixed(2)} blocks`
        : `pathfinder refused: ${outcome.detail ?? 'no detail'}`;
    }
    check(
      'a movement changes the reported position',
      moved > 0.75,
      `${lastDetail}. Every direction tried was blocked, or the pathfinder is not loaded`,
    );
    if (moved > 0.75) note(`moved ${moved.toFixed(2)} blocks`);

    await withTimeout(actuators.stop(), 5_000, 'stop');

    // --- 6. Entities and inventory read at all ----------------------------
    const entities = sensors.entities();
    check(
      'entity list is readable',
      Array.isArray(entities),
      `entities() returned ${typeof entities}`,
    );
    check(
      'the bot does not see itself as another entity',
      entities.every(
        (e) => distance(e.position, sensors.body().position) > 1e-9,
      ),
      'an entity was reported at exactly the bot position, which is the bot itself leaking into sight',
    );
    check(
      'inventory is readable',
      Array.isArray(sensors.inventory()),
      'inventory() did not return an array',
    );
  } finally {
    // --- 7. Clean disconnect ----------------------------------------------
    try {
      await withTimeout(body.disconnect(), DISCONNECT_TIMEOUT_MS, 'disconnect');
      check(
        'disconnect leaves the port marked disconnected',
        body.connected === false,
        'connected was still true after disconnect()',
      );
      check(
        'disconnecting twice is harmless',
        await body
          .disconnect()
          .then(() => true)
          .catch(() => false),
        'a second disconnect() threw',
      );
    } catch (error) {
      fail('clean disconnect', describe(error));
    }
  }
}

const watchdog = setTimeout(() => {
  console.error(
    `\nsmoke test exceeded its overall budget of ${TOTAL_TIMEOUT_MS}ms and was killed. ` +
      'Something is waiting on the server that will never arrive.',
  );
  process.exit(1);
}, TOTAL_TIMEOUT_MS);

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nsmoke test aborted: ${describe(error)}`);
} finally {
  clearTimeout(watchdog);
}

console.log('');
if (failures === 0) {
  console.log(`smoke test passed: ${checks} checks`);
} else {
  console.error(`smoke test FAILED: ${failures} of ${checks} checks failed`);
}
// Leave explicitly. A socket the library did not close would otherwise keep the
// process alive long after the result is known.
process.exit(failures === 0 ? 0 : 1);
