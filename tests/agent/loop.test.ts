import { describe, expect, it } from 'vitest';
import { GoalStack } from '../../src/agent/goal.js';
import { AgentLoop, formatTrace } from '../../src/agent/loop.js';
import type { AgentLoopOptions } from '../../src/agent/loop.js';
import { AgentMemory } from '../../src/agent/memory.js';
import type {
  Decision,
  Policy,
  PolicyInput,
} from '../../src/agent/policy.js';
import { RulePolicy, ScriptedPolicy } from '../../src/agent/policy.js';
import { MemoryLogger } from '../../src/runtime/logger.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FakeInvoker, FakeWorld, block, defaultBody, obs } from './support.js';

function setup(
  overrides: Partial<AgentLoopOptions> & { policy: Policy },
): {
  loop: AgentLoop;
  world: FakeWorld;
  invoker: FakeInvoker;
  clock: ManualClock;
} {
  const clock = new ManualClock(1_000);
  const world = (overrides.world as FakeWorld | undefined) ?? new FakeWorld(clock);
  const invoker = (overrides.invoker as FakeInvoker | undefined) ?? new FakeInvoker();
  const loop = new AgentLoop({
    ...overrides,
    world,
    invoker,
    clock,
  });
  return { loop, world, invoker, clock };
}

describe('run to completion', () => {
  it('drives a scripted policy through skills to a done', async () => {
    const policy = new ScriptedPolicy([
      { kind: 'skill', name: 'move_to', input: { x: 10, y: 64, z: 10 } },
      { kind: 'skill', name: 'collect_block', input: { name: 'oak_log' } },
      { kind: 'speak', text: 'got the wood' },
      { kind: 'done', reason: 'goal complete' },
    ]);
    const said: string[] = [];
    const { loop, invoker } = setup({ policy, speak: (t) => void said.push(t) });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('done');
    expect(trace.reason).toBe('goal complete');
    expect(trace.steps).toHaveLength(4);
    expect(invoker.calls.map((c) => c.name)).toEqual([
      'move_to',
      'collect_block',
    ]);
    expect(said).toEqual(['got the wood']);
  });

  it('records every decision and outcome in the trace', async () => {
    const policy = new ScriptedPolicy([
      { kind: 'skill', name: 'ok_skill', input: {} },
      { kind: 'skill', name: 'bad_skill', input: {} },
      { kind: 'done', reason: 'enough' },
    ]);
    const invoker = new FakeInvoker({
      ok_skill: { ok: true, value: { mined: 3 }, durationMs: 12 },
      bad_skill: {
        ok: false,
        kind: 'unreachable',
        message: 'no path',
        retryable: true,
        durationMs: 7,
      },
    });
    const { loop } = setup({ policy, invoker });

    const trace = await loop.run();

    expect(trace.steps.map((s) => s.decision.kind)).toEqual([
      'skill',
      'skill',
      'done',
    ]);
    expect(trace.steps.map((s) => s.outcome.kind)).toEqual([
      'skill-ok',
      'skill-failed',
      'done',
    ]);
    const failed = trace.steps[1]?.outcome;
    expect(failed?.kind).toBe('skill-failed');
    if (failed?.kind === 'skill-failed') {
      expect(failed.failure).toBe('unreachable');
      expect(failed.retryable).toBe(true);
      expect(failed.message).toBe('no path');
    }
    // The observation each decision was made from is kept, not just the choice.
    for (const step of trace.steps) {
      expect(step.digest).toContain('== body');
      expect(step.endedAt).toBeGreaterThanOrEqual(step.startedAt);
    }
    expect(formatTrace(trace)).toContain('ok_skill ok in 12ms');
    expect(formatTrace(trace)).toContain('perception:');
  });

  it('attaches the perception report to the run', async () => {
    const { loop } = setup({
      policy: new ScriptedPolicy([{ kind: 'done', reason: 'nothing to do' }]),
    });

    const trace = await loop.run();

    expect(trace.perception.total).toBeGreaterThan(0);
    expect(trace.perception.privileged).toBe(0);
    expect(trace.perception.fairPlay).toBe(true);
  });

  it('reports the goals it worked on', async () => {
    const clock = new ManualClock(0);
    const goals = new GoalStack({ clock });
    goals.push('gather 1 oak_log');
    const loop = new AgentLoop({
      world: new FakeWorld(clock),
      invoker: new FakeInvoker(),
      policy: new ScriptedPolicy([{ kind: 'done', reason: 'stop' }]),
      clock,
      goals,
    });

    const trace = await loop.run();

    expect(trace.steps[0]?.goal).toBe('gather 1 oak_log');
    expect(trace.goals.map((g) => g.description)).toContain('gather 1 oak_log');
  });
});

describe('budget', () => {
  it('stops at the step budget when the policy never finishes', async () => {
    const forever: Policy = {
      decide: () =>
        Promise.resolve<Decision>({ kind: 'skill', name: 'dig', input: {} }),
    };
    const { loop, invoker } = setup({ policy: forever, maxSteps: 5 });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('budget');
    expect(trace.reason).toContain('5');
    expect(trace.steps).toHaveLength(5);
    expect(invoker.calls).toHaveLength(5);
  });

  it('runs no steps at all with a budget of zero', async () => {
    const { loop, invoker } = setup({
      policy: new ScriptedPolicy([{ kind: 'skill', name: 'dig', input: {} }]),
      maxSteps: 0,
    });

    const trace = await loop.run();

    expect(trace.steps).toHaveLength(0);
    expect(invoker.calls).toHaveLength(0);
    expect(trace.stoppedBecause).toBe('budget');
  });

  it('tells the policy where it is in the budget', async () => {
    const seen: number[] = [];
    const policy: Policy = {
      decide: (i: PolicyInput) => {
        seen.push(i.step);
        return Promise.resolve<Decision>(
          i.step === 2
            ? { kind: 'done', reason: 'stopping' }
            : { kind: 'skill', name: 'dig', input: {} },
        );
      },
    };
    const { loop } = setup({ policy, maxSteps: 9 });

    await loop.run();

    expect(seen).toEqual([0, 1, 2]);
  });
});

describe('abort', () => {
  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('supervisor said stop'));
    const { loop, invoker } = setup({
      policy: new ScriptedPolicy([{ kind: 'skill', name: 'dig', input: {} }]),
      signal: controller.signal,
    });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('aborted');
    expect(trace.reason).toContain('supervisor said stop');
    expect(trace.steps).toHaveLength(0);
    expect(invoker.calls).toHaveLength(0);
  });

  it('stops between steps once aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const policy: Policy = {
      decide: () => {
        calls += 1;
        if (calls === 2) controller.abort('drowning');
        return Promise.resolve<Decision>({
          kind: 'skill',
          name: 'dig',
          input: {},
        });
      },
    };
    const { loop, invoker } = setup({
      policy,
      signal: controller.signal,
      maxSteps: 20,
    });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('aborted');
    expect(trace.reason).toBe('drowning');
    // The decision taken while the abort fired is recorded but not acted on.
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]?.outcome.kind).toBe('aborted');
    expect(invoker.calls).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('records a throwing policy instead of crashing the run', async () => {
    const policy: Policy = {
      decide: () => Promise.reject(new Error('model exploded')),
    };
    const { loop } = setup({ policy });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('error');
    expect(trace.reason).toBe('model exploded');
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.outcome.kind).toBe('policy-error');
  });

  it('records a throwing invoker as a failure and keeps going', async () => {
    const invoker = new FakeInvoker();
    invoker.invoke = () => Promise.reject(new Error('transport closed'));
    const { loop } = setup({
      policy: new ScriptedPolicy([
        { kind: 'skill', name: 'dig', input: {} },
        { kind: 'done', reason: 'giving up' },
      ]),
      invoker,
    });

    const trace = await loop.run();

    expect(trace.stoppedBecause).toBe('done');
    const outcome = trace.steps[0]?.outcome;
    expect(outcome?.kind).toBe('skill-failed');
    if (outcome?.kind === 'skill-failed') {
      expect(outcome.message).toContain('transport closed');
    }
  });
});

describe('memory and logging', () => {
  it('writes decisions and outcomes into memory', async () => {
    const clock = new ManualClock(0);
    const memory = new AgentMemory({ clock, budgetChars: 100_000 });
    const loop = new AgentLoop({
      world: new FakeWorld(clock),
      invoker: new FakeInvoker(),
      policy: new ScriptedPolicy([
        { kind: 'skill', name: 'dig', input: {} },
        { kind: 'done', reason: 'stop' },
      ]),
      clock,
      memory,
    });

    await loop.run();

    const roles = memory.turns().map((t) => t.role);
    expect(roles).toEqual(['action', 'outcome', 'action', 'outcome']);
    expect(memory.turns()[0]?.text).toContain('skill dig');
  });

  it('keeps the digest out of memory unless asked', async () => {
    const clock = new ManualClock(0);
    const memory = new AgentMemory({ clock, budgetChars: 100_000 });
    const loop = new AgentLoop({
      world: new FakeWorld(clock),
      invoker: new FakeInvoker(),
      policy: new ScriptedPolicy([{ kind: 'done', reason: 'stop' }]),
      clock,
      memory,
      recordDigestInMemory: true,
    });

    await loop.run();

    expect(memory.turns()[0]?.role).toBe('observation');
  });

  it('logs the end of a run', async () => {
    const clock = new ManualClock(0);
    const log = new MemoryLogger(() => clock.now());
    const loop = new AgentLoop({
      world: new FakeWorld(clock),
      invoker: new FakeInvoker(),
      policy: new ScriptedPolicy([{ kind: 'done', reason: 'stop' }]),
      clock,
      log,
    });

    await loop.run();

    expect(log.records.some((r) => r.message === 'run finished')).toBe(true);
  });
});

describe('rule policy end to end', () => {
  it('gathers a sighted block and then reports the goal satisfied', async () => {
    const clock = new ManualClock(0);
    const world = new FakeWorld(clock);
    world.bodyState = defaultBody();
    world.blocks = [obs(block('oak_log', { x: 1, y: 64, z: 1 }), 'sight', 0)];

    const invoker = new FakeInvoker({
      collectBlock: () => {
        world.items = [{ name: 'oak_log', count: 2 }];
        world.blocks = [];
        return { ok: true, value: { collected: 2 }, durationMs: 20 };
      },
    });
    const goals = new GoalStack({ clock });
    goals.push('gather 2 oak_log');

    const loop = new AgentLoop({
      world,
      invoker,
      policy: new RulePolicy(),
      clock,
      goals,
      maxSteps: 8,
      // No blockNames configured on purpose: the loop must derive them from
      // the active goal, or the policy sees an empty world and gives up.
    });

    const trace = await loop.run();

    expect(invoker.calls.map((c) => c.name)).toEqual(['collectBlock']);
    expect(trace.stoppedBecause).toBe('done');
    expect(trace.reason).toContain('goal satisfied');
    expect(trace.steps).toHaveLength(2);
  });
});
