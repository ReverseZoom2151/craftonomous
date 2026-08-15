import { describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { buildReport, formatReport, toJSON } from '../../src/eval/report.js';
import { runSuite } from '../../src/eval/runner.js';
import type { AttemptContext } from '../../src/eval/runner.js';
import { createSandboxExecutor } from '../../src/eval/sandbox-executor.js';
import type { SandboxScenario } from '../../src/eval/sandbox-executor.js';
import { REFUSAL_SUITE } from '../../src/eval/suites/index.js';
import { defineManifest } from '../../src/eval/task.js';
import type { Task, TaskManifest } from '../../src/eval/task.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import type { PerceptionReport } from '../../src/perception/ledger.js';
import type { Action, Policy } from '../../src/sandbox/runner.js';
import { planningPolicy } from '../../src/sandbox/runner.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * The seam between the evaluation harness and the symbolic sandbox.
 *
 * `src/eval/` and `src/sandbox/` were written to the same brief and each was
 * tested only against itself. This file drives the whole offline tier in one
 * go: a real suite from `src/eval/suites/`, a real `createSandboxExecutor` over
 * a real `SymbolicWorld`, a real `runSuite`, and a real formatted report. The
 * perception report printed beside the score is taken from a real
 * `createOfflineSession` that actually read a world, rather than being a
 * literal typed into the test.
 */

/** Attempt a real run against the offline body, so the ledger is not invented. */
function realPerception(): PerceptionReport {
  const clock = new ManualClock(1_000);
  const world = new FakeWorld();
  world.fill({ x: -8, y: 63, z: -8 }, { x: 8, y: 63, z: 8 }, 'stone');
  world.setBlock({ x: 1, y: 64, z: 0 }, 'oak_log');

  const session = createOfflineSession({
    world,
    clock,
    autoStart: false,
    log: silentLogger,
  });
  // Reading the world is what puts rows in the ledger.
  session.world.body();
  session.world.findBlocks({ names: ['oak_log'], maxDistance: 16 });
  return session.world.report();
}

/** Stops immediately with a stated reason, which is how a refusal is made. */
function stopsWith(reason: string): Policy {
  return (): Action => ({ kind: 'stop', reason });
}

const NOTHING_USEFUL: SandboxScenario = { resources: { cobblestone: 64 } };

function context(): AttemptContext {
  return {
    repeat: 0,
    seed: 1,
    signal: new AbortController().signal,
    timeBudgetMs: 60_000,
  };
}

function taskById(id: string): Task {
  const found = REFUSAL_SUITE.tasks.find((t) => t.id === id);
  if (found === undefined)
    throw new Error(`no task ${id} in the refusal suite`);
  return found;
}

/** A one-task manifest cut from a real suite, so the task data is real. */
function only(ids: readonly string[]): TaskManifest {
  return defineManifest({
    name: REFUSAL_SUITE.name,
    version: REFUSAL_SUITE.version,
    description: REFUSAL_SUITE.description,
    tasks: ids.map(taskById),
  });
}

const BEDROCK = 'refusal.impossible.bedrock';
const LOGS = 'refusal.possible.logs';

describe('the eval harness over the symbolic sandbox', () => {
  it('scores a refused impossible task as success', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => NOTHING_USEFUL,
      policy: stopsWith('impossible: bedrock has no survival drop'),
    });

    const outcome = await executor(taskById(BEDROCK), context());

    expect(outcome.kind).toBe('refused');

    const run = await runSuite(only([BEDROCK]), executor, {
      clock: new ManualClock(),
    });
    expect(run.attempts[0]?.scored.credited).toBe(true);
    expect(run.attempts[0]?.scored.falseClaim).toBe(false);
    expect(run.score.impossible.credited).toBe(1);
  });

  it('scores the same impossible task as failure when it is merely attempted', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => NOTHING_USEFUL,
      // Gave up, rather than recognising that the goal cannot be met. Same
      // task, same world, same harness: only the stated reason differs.
      policy: stopsWith('ran out of ideas after digging for a while'),
    });

    const outcome = await executor(taskById(BEDROCK), context());

    expect(outcome.kind).toBe('failure');

    const run = await runSuite(only([BEDROCK]), executor, {
      clock: new ManualClock(),
    });
    expect(run.attempts[0]?.scored.credited).toBe(false);
    expect(run.score.impossible.credited).toBe(0);
  });

  it('scores a satisfiable control task by actually gathering in the sandbox', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ resources: { oak_log: 8 } }),
      policyFor: (_task, predicate) =>
        planningPolicy({
          item: predicate.kind === 'item-tag-count' ? 'oak_log' : 'oak_log',
          count: 2,
        }),
    });

    const run = await runSuite(only([LOGS]), executor, {
      clock: new ManualClock(),
    });

    expect(run.attempts[0]?.outcome.kind).toBe('success');
    expect(run.score.possible.credited).toBe(1);
    expect(
      executor.records[0]?.run?.world.inventory.count('oak_log'),
    ).toBeGreaterThanOrEqual(2);
  });

  it('scores a positional goal, not only an inventory one', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => NOTHING_USEFUL,
      policy: stopsWith('impossible: y=5000 is beyond the build limit'),
    });

    // The altitude goal is `agent-y-at-least`, which needs a position. The
    // sandbox models one, so this is scorable offline rather than an error.
    const outcome = await executor(
      taskById('refusal.impossible.altitude'),
      context(),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.detail).toContain('agent y is');

    const run = await runSuite(
      only(['refusal.impossible.altitude']),
      executor,
      { clock: new ManualClock() },
    );
    expect(run.attempts[0]?.scored.credited).toBe(true);
  });

  it('prints the profile and the privileged share beside every score', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => NOTHING_USEFUL,
      policy: stopsWith('impossible: bedrock has no survival drop'),
    });
    const run = await runSuite(only([BEDROCK, LOGS]), executor, {
      clock: new ManualClock(),
    });

    const perception = realPerception();
    const report = buildReport(run, {
      agent: 'refuse-everything',
      profile: FAIR_PLAY,
      perception,
      reliability: [
        {
          skill: 'collectBlock',
          attempts: 3,
          successes: 2,
          rate: 2 / 3,
          confidence: 0.2,
          meanDurationMs: 12,
        },
      ],
    });

    const text = formatReport(report);

    expect(text).toContain('profile=fair-play');
    expect(text).toContain('privileged=0.0%');
    expect(text).toContain('fair-play=yes');
    expect(text).toContain(`reads: ${perception.total} total, 0 privileged`);
    // The conditions are repeated on every block that carries a number, so a
    // row pasted somewhere else takes them along.
    expect(text.match(/profile=fair-play/g)?.length ?? 0).toBeGreaterThan(2);
    expect(text).toContain('skill reliability');
    expect(text).toContain(
      'This score is valid only under profile "fair-play"',
    );

    const json = toJSON(report);
    expect(json.profile['name']).toBe('fair-play');
    expect(json.perception.privilegedShare).toBe(0);
    expect(json.suite.hash).toBe(run.manifestHash);
  });

  it('runs a whole real suite offline without a server, and names its conditions', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ resources: { oak_log: 8, cobblestone: 64 } }),
      policy: stopsWith('impossible: this goal cannot be met'),
    });

    const run = await runSuite(REFUSAL_SUITE, executor, {
      clock: new ManualClock(),
    });

    expect(run.attempts).toHaveLength(REFUSAL_SUITE.tasks.length);
    expect(run.manifestHash).toHaveLength(16);
    // Refusing everything earns the impossible tasks and loses the controls,
    // which is exactly what the suite exists to show.
    expect(run.score.impossible.credited).toBeGreaterThan(0);
    expect(run.score.possible.credited).toBe(0);
    expect(run.score.falseClaims).toBe(0);

    const text = formatReport(
      buildReport(run, {
        agent: 'refuse-everything',
        profile: FAIR_PLAY,
        perception: realPerception(),
      }),
    );
    expect(text).toContain(`suite: refusal v${REFUSAL_SUITE.version}`);
    expect(text).toContain('discrimination');
  });
});

describe('the shipped sandbox baseline against the refusal suite', () => {
  it('refuses bedrock in words the harness recognises as a refusal', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => NOTHING_USEFUL,
      policyFor: () => planningPolicy({ item: 'bedrock', count: 1 }),
    });

    const outcome = await executor(taskById(BEDROCK), context());

    // Three layers have to agree for this to hold: the tech tree has to fail
    // to plan, `planningPolicy` has to phrase that as a stop reason, and
    // `declaresImpossible` in `src/eval/live.ts` has to read that phrasing as
    // impossibility rather than as giving up. Nothing but this test checks it.
    expect(executor.records[0]?.run?.outcome).toBe('refused');
    expect(outcome.kind).toBe('refused');
    expect(outcome.detail).toContain('declared impossible');
  });

  it('does not refuse a control task it can actually plan', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ resources: { oak_log: 8 } }),
      policyFor: () => planningPolicy({ item: 'oak_log', count: 2 }),
    });

    const outcome = await executor(taskById(LOGS), context());

    expect(outcome.kind).toBe('success');
  });
});
