import { describe, expect, it } from 'vitest';
import { GoalStack } from '../../src/agent/goal.js';
import { AgentLoop, formatTrace } from '../../src/agent/loop.js';
import type { RunTrace } from '../../src/agent/loop.js';
import { RulePolicy } from '../../src/agent/policy.js';
import type { SkillDescriptor } from '../../src/agent/policy.js';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';
import type { OfflineSession } from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * End to end: the reference agent playing the in-memory game.
 *
 * Everything below the policy is real. A `createOfflineSession` assembles the
 * gate, the adapter, the memory, the registry and the runner over a real
 * `FakeWorld`; `AgentLoop` drives it; and the only thing written here is the
 * world the agent wakes up in.
 *
 * ## No adapter here, and that is the point
 *
 * This file used to carry a shim. The MCP surface's invoker exposes
 * `run(name, input, ctx)` and the agent layer wants
 * `invoke(name, input, {signal})`; both were called "SkillInvoker", neither
 * was assignable to the other, and nothing bridged them, so an agent could not
 * be pointed at an assembled session. `SessionInvoker` now satisfies both, so
 * `session.invoker` goes straight into `AgentLoop`. If that shim ever has to
 * come back, this test is where it will show up first.
 */
const FLOOR_Y = 63;

function floored(radius: number): FakeWorld {
  const world = new FakeWorld();
  world.fill(
    { x: -radius, y: FLOOR_Y, z: -radius },
    { x: radius, y: FLOOR_Y, z: radius },
    'stone',
  );
  return world;
}

function catalogue(session: OfflineSession): readonly SkillDescriptor[] {
  return session.registry
    .list()
    .map((skill) => ({ name: skill.name, summary: skill.summary }));
}

interface Rig {
  readonly session: OfflineSession;
  readonly loop: AgentLoop;
  readonly world: FakeWorld;
}

function rig(world: FakeWorld, goal: string, maxSteps = 12): Rig {
  const clock = new ManualClock(1_000);
  const session = createOfflineSession({
    world,
    clock,
    autoStart: false,
    log: silentLogger,
  });
  const goals = new GoalStack({ clock });
  goals.push(goal);

  const loop = new AgentLoop({
    world: session.world,
    invoker: session.invoker,
    policy: new RulePolicy(),
    clock,
    goals,
    skills: catalogue(session),
    maxSteps,
    log: silentLogger,
  });
  return { session, loop, world };
}

describe('the reference agent plays the offline body', () => {
  it('gathers what its goal asked for and stops on purpose', async () => {
    const world = floored(24);
    world.setBlock({ x: 4, y: 64, z: 0 }, 'oak_log');
    world.setBlock({ x: 6, y: 64, z: 5 }, 'oak_log');
    world.setBlock({ x: 7, y: 64, z: -5 }, 'oak_log');

    const { loop, session } = rig(world, 'gather 3 oak_log');
    const trace = await loop.run();

    // The thing it was asked for is actually in the inventory of the real world.
    expect(world.countItem('oak_log')).toBeGreaterThanOrEqual(3);
    expect(session.world.inventory().value).toContainEqual(
      expect.objectContaining({ name: 'oak_log' }),
    );

    expect(trace.stoppedBecause).toBe('done');
    expect(trace.reason).toContain('goal satisfied');

    // And the body really moved to get there.
    expect(session.body.actuators.actionsOfKind('dig').length).toBeGreaterThan(
      0,
    );
  });

  it('records every step of the run, decision and outcome alike', async () => {
    const world = floored(24);
    world.setBlock({ x: 4, y: 64, z: 0 }, 'oak_log');
    world.setBlock({ x: 6, y: 64, z: 5 }, 'oak_log');

    const { loop } = rig(world, 'gather 2 oak_log');
    const trace = await loop.run();

    expect(trace.steps.length).toBeGreaterThan(0);
    trace.steps.forEach((step, index) => {
      expect(step.step).toBe(index);
      expect(step.goal).toBe('gather 2 oak_log');
      expect(step.decision.kind).toBeDefined();
      expect(step.outcome.kind).toBeDefined();
      // The digest the decision was made from is kept, so the step can be
      // reconstructed rather than guessed at afterwards.
      expect(step.digest).toContain('== body');
    });

    const collected = trace.steps.find(
      (s) => s.decision.kind === 'skill' && s.decision.name === 'collectBlock',
    );
    expect(collected?.outcome.kind).toBe('skill-ok');

    expect(formatTrace(trace)).toContain('fair play yes');
  });

  it('reports fair play with a zero privileged share', async () => {
    const world = floored(24);
    world.setBlock({ x: 4, y: 64, z: 0 }, 'oak_log');

    const { loop } = rig(world, 'gather 1 oak_log');
    const trace = await loop.run();

    expectFairPlay(trace);
    expect(trace.perception.total).toBeGreaterThan(0);
    expect(trace.perception.counts.sight).toBeGreaterThan(0);
    expect(trace.perception.counts.proprioception).toBeGreaterThan(0);
  });

  it('spends its budget honestly when the goal cannot be met', async () => {
    // A small island: nothing to gather, and nowhere to explore to.
    const { loop, world } = rig(floored(6), 'gather 2 diamond', 6);
    const trace = await loop.run();

    expect(world.countItem('diamond')).toBe(0);
    expect(['budget', 'done']).toContain(trace.stoppedBecause);
    // Whatever it did, it is on the record and it was fairly obtained.
    expect(trace.steps.length).toBeGreaterThan(0);
    expectFairPlay(trace);
  });
});

function expectFairPlay(trace: RunTrace): void {
  expect(trace.perception.fairPlay).toBe(true);
  expect(trace.perception.privileged).toBe(0);
  expect(trace.perception.privilegedShare).toBe(0);
}
