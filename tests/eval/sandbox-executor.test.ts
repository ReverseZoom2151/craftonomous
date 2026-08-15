import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../src/runtime/clock.js';
import type { Action, Policy } from '../../src/sandbox/runner.js';
import type { Vec3 } from '../../src/sandbox/space.js';
import { createSandboxExecutor } from '../../src/eval/sandbox-executor.js';
import type { SandboxScenario } from '../../src/eval/sandbox-executor.js';
import type { AttemptContext } from '../../src/eval/runner.js';
import { defineTask } from '../../src/eval/task.js';
import type { Task } from '../../src/eval/task.js';

function evalTask(overrides: Partial<Task> = {}): Task {
  return defineTask('1.0.0', {
    id: overrides.id ?? 'sandbox.demo',
    title: overrides.title ?? 'demo',
    description: overrides.description ?? 'demo',
    version: '1.0.0',
    tags: [],
    difficulty: 'easy',
    goal:
      overrides.goal ??
      'inventory contains at least 4 items tagged minecraft:planks',
    budget: overrides.budget ?? { maxSteps: 16, maxDurationMs: 60_000 },
    profile: overrides.profile ?? 'fair-play',
    impossible: overrides.impossible ?? false,
  });
}

function context(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    repeat: overrides.repeat ?? 0,
    seed: overrides.seed ?? 1,
    signal: overrides.signal ?? new AbortController().signal,
    timeBudgetMs: overrides.timeBudgetMs ?? 60_000,
  };
}

/** Plays a fixed list of actions, repeating the last one once exhausted. */
function script(actions: readonly Action[]): Policy {
  return (_world, step): Action =>
    actions[Math.min(step, actions.length - 1)] ?? { kind: 'stop' };
}

const FOREST: SandboxScenario = { resources: { oak_log: 8 } };

/** The three goals that used to report themselves unscorable in this tier. */
const PLACEMENT: Partial<Task> = {
  goal: 'a minecraft:crafting_table block exists within 4 blocks of the agent',
};
const SHELTER: Partial<Task> = {
  goal: 'agent position is fully enclosed by solid blocks and sky access is 0',
};
const ALTITUDE: Partial<Task> = {
  goal: 'agent y position is at least 5000 (beyond the build limit)',
};

/** The six face neighbours of (0, 64, 0), in the world's own order. */
const FACES: readonly Vec3[] = [
  { x: 1, y: 64, z: 0 },
  { x: -1, y: 64, z: 0 },
  { x: 0, y: 65, z: 0 },
  { x: 0, y: 63, z: 0 },
  { x: 0, y: 64, z: 1 },
  { x: 0, y: 64, z: -1 },
];

describe('createSandboxExecutor', () => {
  it('scores a met goal as success, matching namespaced names to bare ones', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
        { kind: 'stop', reason: 'done' },
      ]),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('success');
    expect(outcome.steps).toBe(2);
    expect(executor.records[0]?.run?.world.inventory.count('oak_planks')).toBe(
      4,
    );
  });

  it('matches a namespaced single-item goal against the sandbox inventory', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'mine', resource: 'oak_log', count: 2 }]),
    });

    const outcome = await executor(
      evalTask({ goal: 'inventory contains at least 2 minecraft:oak_log' }),
      context(),
    );
    expect(outcome.kind).toBe('success');
  });

  it('scores an exhausted step budget as timeout', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'mine', resource: 'oak_log', count: 1 }]),
    });

    const outcome = await executor(
      evalTask({
        goal: 'inventory contains at least 40 items tagged minecraft:logs',
        budget: { maxSteps: 3, maxDurationMs: 60_000 },
      }),
      context(),
    );
    expect(outcome.kind).toBe('timeout');
    expect(outcome.steps).toBe(3);
  });

  it('scores a deliberate stop on a possible task as failure', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'stop', reason: 'bored of chopping wood' }]),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('failure');
  });

  it('scores a considered refusal on an impossible task as refused', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ resources: { cobblestone: 64 }, craftingTable: true }),
      policy: script([
        { kind: 'stop', reason: 'no recipe turns cobblestone into diamond' },
      ]),
    });

    const outcome = await executor(
      evalTask({
        id: 'refusal.impossible.diamonds-from-cobble',
        goal: 'inventory contains at least 1 minecraft:diamond, having only cobblestone as input (unsatisfiable)',
        impossible: true,
      }),
      context(),
    );
    expect(outcome.kind).toBe('refused');
  });

  it('does not read a refusal into an unexplained stop', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'stop' }]),
    });

    const outcome = await executor(evalTask({ impossible: true }), context());
    expect(outcome.kind).toBe('failure');
    expect(outcome.detail).toMatch(/no reason given/);
  });

  it('scores a policy that throws as error', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: () => {
        throw new Error('planner blew up');
      },
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/planner blew up/);
  });

  it('reports a task with no scenario as an error, not a failure', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => undefined,
      policy: script([{ kind: 'stop' }]),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/no sandbox scenario/);
  });

  it('scores the crafting table placement goal when the block goes down', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
        { kind: 'craft', item: 'crafting_table', count: 1 },
        {
          kind: 'place',
          block: 'crafting_table',
          at: { x: 1, y: 64, z: 0 },
        },
      ]),
    });

    const outcome = await executor(evalTask(PLACEMENT), context());
    expect(outcome.kind).toBe('success');
    expect(outcome.detail).toMatch(/crafting_table at \(1, 64, 0\)/);
  });

  it('scores the placement goal as unmet when the table is only crafted', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
        { kind: 'craft', item: 'crafting_table', count: 1 },
        { kind: 'stop', reason: 'crafted it, never put it down' },
      ]),
    });

    const outcome = await executor(evalTask(PLACEMENT), context());
    expect(outcome.kind).toBe('failure');
    expect(outcome.detail).toMatch(/no crafting_table within 4 blocks/);
  });

  it('scores the shelter goal when all six faces are sealed', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({
        startingInventory: { cobblestone: 6 },
        agent: { x: 0, y: 64, z: 0 },
      }),
      policy: script(
        FACES.map((at) => ({
          kind: 'place' as const,
          block: 'cobblestone',
          at,
        })),
      ),
    });

    const outcome = await executor(evalTask(SHELTER), context());
    expect(outcome.kind).toBe('success');
    expect(outcome.detail).toMatch(/all six faces are solid/);
    // The offline check is weaker than the sentence asks for, and says so.
    expect(outcome.detail).toMatch(/only the six face neighbours/);
  });

  it('scores the shelter goal as unmet when one face is left open', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({
        startingInventory: { cobblestone: 6 },
        agent: { x: 0, y: 64, z: 0 },
      }),
      policy: script([
        ...FACES.slice(0, 5).map((at) => ({
          kind: 'place' as const,
          block: 'cobblestone',
          at,
        })),
        { kind: 'stop', reason: 'left the door open' },
      ]),
    });

    const outcome = await executor(evalTask(SHELTER), context());
    expect(outcome.kind).toBe('failure');
    expect(outcome.detail).toMatch(/open faces: \(0, 64, -1\)/);
  });

  it('reads the agent y for the altitude goal, and refusing it scores as refused', async () => {
    const refuser = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ agent: { x: 0, y: 64, z: 0 } }),
      policy: script([
        { kind: 'stop', reason: 'impossible: y = 5000 is above the build limit' },
      ]),
    });

    const refused = await refuser(
      evalTask({ ...ALTITUDE, impossible: true }),
      context(),
    );
    expect(refused.kind).toBe('refused');
    expect(refused.detail).toMatch(/agent y is 64, needed 5000/);

    // Climbing is a legal thing to try and gets nowhere near, because the
    // sandbox enforces a build limit rather than pretending y is unbounded.
    const climber = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ agent: { x: 0, y: 64, z: 0 } }),
      policyFor: () => (world) => ({
        kind: 'move',
        to: { x: 0, y: world.agentPosition.y + 1, z: 0 },
      }),
    });
    const climbed = await climber(
      evalTask({ ...ALTITUDE, impossible: true }),
      context(),
    );
    expect(climbed.kind).toBe('timeout');
    expect(climbed.detail).toMatch(/agent y is 80, needed 5000/);
  });

  it('scores a reachable altitude goal as success', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => ({ agent: { x: 0, y: 64, z: 0 } }),
      policy: script([
        { kind: 'move', to: { x: 0, y: 65, z: 0 } },
        { kind: 'move', to: { x: 0, y: 66, z: 0 } },
      ]),
    });

    const outcome = await executor(
      evalTask({ goal: 'agent y position is at least 66' }),
      context(),
    );
    expect(outcome.kind).toBe('success');
  });

  it('reports an unreadable goal as an error', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'stop' }]),
    });

    const outcome = await executor(
      evalTask({ goal: 'thrive, spiritually' }),
      context(),
    );
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/goal could not be read/);
  });

  it('builds a policy per task when given a factory', async () => {
    const seen: string[] = [];
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policyFor: (task, predicate) => {
        seen.push(`${task.id}:${predicate.kind}`);
        return script([{ kind: 'mine', resource: 'oak_log', count: 4 }]);
      },
    });

    const outcome = await executor(
      evalTask({
        goal: 'inventory contains at least 4 items tagged minecraft:logs',
      }),
      context(),
    );
    expect(outcome.kind).toBe('success');
    expect(seen).toEqual(['sandbox.demo:item-tag-count']);
  });

  it('refuses to be built with both a policy and a policy factory', () => {
    expect(() =>
      createSandboxExecutor({
        scenario: () => FOREST,
        policy: script([{ kind: 'stop' }]),
        policyFor: () => script([{ kind: 'stop' }]),
      }),
    ).toThrow(/exactly one/);
  });

  it('keeps a record per attempt, carrying the predicate it scored against', async () => {
    const executor = createSandboxExecutor({
      clock: new ManualClock(),
      scenario: () => FOREST,
      policy: script([{ kind: 'mine', resource: 'oak_log', count: 1 }]),
    });

    await executor(
      evalTask({
        goal: 'inventory contains at least 1 items tagged minecraft:logs',
      }),
      context({ repeat: 1, seed: 5 }),
    );
    const record = executor.records[0];
    expect(record?.repeat).toBe(1);
    expect(record?.seed).toBe(5);
    expect(record?.predicate).toMatchObject({
      kind: 'item-tag-count',
      count: 1,
    });
  });
});
