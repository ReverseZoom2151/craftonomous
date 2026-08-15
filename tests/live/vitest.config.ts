import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the live suite, which needs a real Minecraft server.
 *
 * These tests are kept out of the normal run by two independent mechanisms, and
 * either one alone would be enough:
 *
 * 1. File naming. The root config collects `tests/**\/*.test.ts`; the live
 *    files are named `*.live-test.ts`, so `npx vitest run` never even sees
 *    them and the reported test count does not move.
 * 2. An environment guard inside each file. Every suite is skipped unless
 *    `CRAFTONOMOUS_LIVE=1`, so pointing a runner straight at these files still
 *    does not open a socket by accident.
 *
 * Run them with:
 *   CRAFTONOMOUS_LIVE=1 npx vitest run --config tests/live/vitest.config.ts
 *
 * The root of this config is `tests/live`, so the include glob below is
 * relative to that directory.
 */
export default defineConfig({
  test: {
    include: ['**/*.live-test.ts'],
    // A live test waits on a server, a spawn and a pathfinder. Five seconds is
    // a unit-test budget and would fail on latency alone.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One connection at a time. Parallel files would mean parallel joins, and a
    // join burst is exactly the shape of traffic that gets an account rate
    // limited on a server that is not in offline mode.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
