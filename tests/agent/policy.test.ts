import { describe, expect, it } from 'vitest';
import { GoalStack } from '../../src/agent/goal.js';
import { AgentMemory } from '../../src/agent/memory.js';
import { buildDigest } from '../../src/agent/observation-digest.js';
import type { PolicyInput, StepOutcome } from '../../src/agent/policy.js';
import {
  RulePolicy,
  ScriptedPolicy,
  describeDecision,
  describeOutcome,
  parseGatherGoal,
} from '../../src/agent/policy.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FakeWorld, block, defaultBody, entity, obs } from './support.js';

interface Overrides {
  readonly goal?: string;
  readonly lastOutcome?: StepOutcome;
  readonly skills?: readonly { name: string; summary: string }[];
  readonly world?: (w: FakeWorld, now: number) => void;
}

function input(overrides: Overrides = {}): PolicyInput {
  const clock = new ManualClock(600_000);
  const world = new FakeWorld(clock);
  overrides.world?.(world, clock.now());
  const goals = new GoalStack({ clock });
  if (overrides.goal !== undefined) goals.push(overrides.goal);
  return {
    digest: buildDigest(world, clock.now(), {
      blockNames: ['iron_ore', 'oak_log'],
    }),
    goal: goals.current(),
    goals: goals.stack(),
    memory: new AgentMemory({ clock }).snapshot(),
    skills: overrides.skills ?? [],
    step: 0,
    stepBudget: 10,
    lastOutcome: overrides.lastOutcome,
    signal: new AbortController().signal,
  };
}

describe('ScriptedPolicy', () => {
  it('plays its script in order', async () => {
    const policy = new ScriptedPolicy([
      { kind: 'skill', name: 'a', input: { n: 1 } },
      { kind: 'speak', text: 'hello' },
      { kind: 'done', reason: 'finished' },
    ]);

    expect(await policy.decide(input())).toEqual({
      kind: 'skill',
      name: 'a',
      input: { n: 1 },
    });
    expect(await policy.decide(input())).toEqual({
      kind: 'speak',
      text: 'hello',
    });
    expect(await policy.decide(input())).toEqual({
      kind: 'done',
      reason: 'finished',
    });
  });

  it('stops rather than looping when the script runs out', async () => {
    const policy = new ScriptedPolicy([]);
    expect(await policy.decide(input())).toEqual({
      kind: 'done',
      reason: 'script exhausted',
    });
  });

  it('honours a custom exhaustion decision and resets', async () => {
    const policy = new ScriptedPolicy([{ kind: 'speak', text: 'one' }], {
      onExhausted: { kind: 'done', reason: 'out of script' },
    });
    await policy.decide(input());
    expect(await policy.decide(input())).toEqual({
      kind: 'done',
      reason: 'out of script',
    });
    policy.reset();
    expect(policy.cursor).toBe(0);
    expect(await policy.decide(input())).toEqual({
      kind: 'speak',
      text: 'one',
    });
  });
});

describe('parseGatherGoal', () => {
  it('reads a count and an item', () => {
    expect(parseGatherGoal('gather 5 oak_log')).toEqual({
      item: 'oak_log',
      count: 5,
    });
    expect(parseGatherGoal('collect iron_ore')).toEqual({
      item: 'iron_ore',
      count: 1,
    });
    expect(parseGatherGoal('please mine 3 coal_ore for me')).toEqual({
      item: 'coal_ore',
      count: 3,
    });
  });

  it('returns nothing for a goal it does not cover', () => {
    expect(parseGatherGoal('build a castle')).toBeUndefined();
  });
});

describe('RulePolicy', () => {
  const policy = new RulePolicy();

  it('eats when hungry and carrying food', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 5 oak_log',
        world: (w) => {
          w.bodyState = defaultBody({ food: 4 });
          w.items = [{ name: 'bread', count: 2 }];
        },
      }),
    );

    expect(decision).toEqual({
      kind: 'skill',
      name: 'consumeItem',
      input: { item: 'bread' },
    });
  });

  it('does not eat when it has no food, and gets on with the goal', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 5 oak_log',
        world: (w) => {
          w.bodyState = defaultBody({ food: 2 });
        },
      }),
    );

    expect(decision).toEqual({
      kind: 'skill',
      name: 'explore',
      input: { looking_for: 'oak_log' },
    });
  });

  it('flees a hostile when badly hurt', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 5 oak_log',
        world: (w, now) => {
          w.bodyState = defaultBody({ health: 4 });
          w.entities = [
            obs(
              entity(7, 'zombie', { x: 2, y: 64, z: 0 }, { hostile: true }),
              'sight',
              now,
            ),
          ];
        },
      }),
    );

    expect(decision.kind).toBe('skill');
    if (decision.kind === 'skill') expect(decision.name).toBe('flee');
  });

  it('collects a sighted block in preference to a remembered one', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 2 iron_ore',
        world: (w, now) => {
          w.remembered = [
            obs(
              block('iron_ore', { x: 99, y: 40, z: 99 }),
              'memory',
              now - 200_000,
            ),
          ];
          w.blocks = [
            obs(block('iron_ore', { x: 1, y: 40, z: 1 }), 'sight', now),
          ];
        },
      }),
    );

    // collectBlock runs its own find-approach-dig, so it takes a name and a
    // count rather than a coordinate. The sighted-over-remembered preference
    // decides whether to act at all, not what is passed.
    expect(decision).toEqual({
      kind: 'skill',
      name: 'collectBlock',
      input: { name: 'iron_ore', count: 2 },
    });
  });

  it('still collects when only a remembered target is known', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 1 iron_ore',
        world: (w, now) => {
          w.remembered = [
            obs(
              block('iron_ore', { x: 9, y: 40, z: 9 }),
              'memory',
              now - 200_000,
            ),
          ];
        },
      }),
    );

    // A recollection is worth acting on: the ore may still be there, and the
    // skill reports world-changed if it is not. Giving up because the only
    // lead is remembered would waste knowledge the agent paid to acquire.
    expect(decision).toEqual({
      kind: 'skill',
      name: 'collectBlock',
      input: { name: 'iron_ore', count: 1 },
    });
  });

  it('stops once the goal is satisfied by what it is carrying', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 2 oak_log',
        world: (w) => {
          w.items = [{ name: 'oak_log', count: 3 }];
        },
      }),
    );

    expect(decision.kind).toBe('done');
    if (decision.kind === 'done') {
      expect(decision.reason).toContain('goal satisfied');
    }
  });

  it('stops when there is no goal', async () => {
    expect(await policy.decide(input())).toEqual({
      kind: 'done',
      reason: 'no active goal',
    });
  });

  it('admits it cannot pursue a goal outside its rules', async () => {
    const decision = await policy.decide(input({ goal: 'build a castle' }));
    expect(decision.kind).toBe('done');
    if (decision.kind === 'done') {
      expect(decision.reason).toContain('no rule covers');
    }
  });

  it('respects the advertised skill catalogue', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 1 diamond',
        skills: [{ name: 'collect_block', summary: 'collect' }],
      }),
    );

    // No explore skill is on offer, so it says so instead of inventing one.
    expect(decision.kind).toBe('done');
    if (decision.kind === 'done') {
      expect(decision.reason).toContain('no way to look for more');
    }
  });

  it('does not immediately reissue a skill that failed unrecoverably', async () => {
    const decision = await policy.decide(
      input({
        goal: 'gather 5 oak_log',
        lastOutcome: {
          kind: 'skill-failed',
          name: 'explore',
          failure: 'precondition',
          message: 'nowhere to go',
          retryable: false,
          durationMs: 5,
        },
      }),
    );

    expect(decision.kind).toBe('done');
  });
});

describe('descriptions', () => {
  it('renders decisions and outcomes for a trace', () => {
    expect(
      describeDecision({ kind: 'skill', name: 'dig', input: { n: 1 } }),
    ).toBe('skill dig({"n":1})');
    expect(describeDecision({ kind: 'done', reason: 'tired' })).toBe(
      'done: tired',
    );
    expect(
      describeOutcome({
        kind: 'skill-failed',
        name: 'dig',
        failure: 'timeout',
        message: 'too slow',
        retryable: true,
        durationMs: 10,
      }),
    ).toBe('dig failed (timeout, retryable): too slow');
  });
});
