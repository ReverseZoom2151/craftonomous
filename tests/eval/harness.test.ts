/**
 * End-to-end: the harness as it is actually used, against the shipped suites.
 */
import { describe, expect, it } from 'vitest';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';
import {
  GATHERING_SUITE,
  REFUSAL_SUITE,
  buildReport,
  formatReport,
  hashManifest,
  runSuite,
} from '../../src/eval/index.js';
import type { TaskExecutor } from '../../src/eval/index.js';

/** Attempts everything, refuses nothing, and reports success regardless. */
const alwaysAttempt: TaskExecutor = async () => ({
  kind: 'success',
  steps: 20,
  durationMs: 500,
});

/** Completes the satisfiable, refuses the unsatisfiable. */
const discriminating: TaskExecutor = async (task) => ({
  kind: task.impossible ? 'refused' : 'success',
  steps: 20,
  durationMs: 500,
});

const options = { clock: new ManualClock(), repeats: 3 } as const;

describe('the refusal suite', () => {
  it('scores an always-attempt agent below a discriminating one', async () => {
    const attempt = await runSuite(REFUSAL_SUITE, alwaysAttempt, options);
    const discriminate = await runSuite(REFUSAL_SUITE, discriminating, options);

    expect(attempt.score.confidence).toBeLessThan(
      discriminate.score.confidence,
    );
    expect(attempt.score.falseClaims).toBeGreaterThan(0);
    expect(discriminate.score.falseClaims).toBe(0);
    expect(attempt.score.discrimination).toBeLessThan(
      discriminate.score.discrimination,
    );
  });

  it('does not let an agent that refuses everything win either', async () => {
    const refuseAll: TaskExecutor = async () => ({
      kind: 'refused',
      steps: 1,
      durationMs: 10,
    });
    const refuse = await runSuite(REFUSAL_SUITE, refuseAll, options);
    const discriminate = await runSuite(REFUSAL_SUITE, discriminating, options);
    expect(refuse.score.confidence).toBeLessThan(discriminate.score.confidence);
  });

  it('does not award a perfect score even to a perfect run', async () => {
    const run = await runSuite(REFUSAL_SUITE, discriminating, options);
    expect(run.score.successRate).toBe(1);
    expect(run.score.confidence).toBeLessThan(1);
  });
});

describe('the gathering suite', () => {
  it('runs end to end and reports under its profile', async () => {
    const run = await runSuite(GATHERING_SUITE, alwaysAttempt, {
      clock: new ManualClock(),
    });
    expect(run.attempts).toHaveLength(GATHERING_SUITE.tasks.length);
    expect(run.manifestHash).toBe(hashManifest(GATHERING_SUITE));

    const ledger = new PerceptionLedger();
    ledger.record('sight', 20);
    const text = formatReport(
      buildReport(run, {
        agent: 'stub',
        profile: FAIR_PLAY,
        perception: ledger.report(),
      }),
    );
    expect(text).toContain('profile=fair-play');
    expect(text).toContain('craft.stone-pickaxe');
  });

  it('has no impossible tasks, so refusal earns nothing there', async () => {
    const refuseAll: TaskExecutor = async () => ({
      kind: 'refused',
      steps: 1,
      durationMs: 10,
    });
    const run = await runSuite(GATHERING_SUITE, refuseAll, {
      clock: new ManualClock(),
    });
    expect(run.score.credited).toBe(0);
    expect(run.score.impossible.attempts).toBe(0);
  });
});
