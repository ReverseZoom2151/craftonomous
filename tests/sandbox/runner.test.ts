import { describe, expect, it } from 'vitest';
import { planningPolicy, runTask } from '../../src/sandbox/runner.js';
import type { Action, Policy } from '../../src/sandbox/runner.js';
import { STARTER_TASKS, defineTask, taskById } from '../../src/sandbox/task.js';
import type { SymbolicTask } from '../../src/sandbox/task.js';

/** A policy that plays a fixed script and then stops. */
function scripted(...actions: readonly Action[]): Policy {
  return (_world, step) =>
    actions[step] ?? { kind: 'stop', reason: 'script ended' };
}

function requireTask(id: string): SymbolicTask {
  const task = taskById(id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

describe('defineTask', () => {
  it('fills in defaults', () => {
    const task = defineTask({
      id: 't',
      description: 'd',
      goal: { item: 'stick', count: 1 },
    });
    expect(task.biome).toBe('plains');
    expect(task.craftingTable).toBe(false);
    expect(task.furnace).toBe(false);
    expect(task.impossible).toBe(false);
    expect(task.stepBudget).toBeUndefined();
    expect(task.startingInventory).toEqual({});
  });

  it('checks the goal against the inventory by default', () => {
    const task = defineTask({
      id: 't',
      description: 'd',
      goal: { item: 'stick', count: 2 },
      startingInventory: { stick: 1 },
    });
    expect(task.check(task.createWorld())).toBe(false);
    const world = task.createWorld();
    world.mine('stick', 1);
    expect(task.check(world)).toBe(false);
  });

  it('accepts a custom goal predicate', () => {
    const task = defineTask({
      id: 't',
      description: 'd',
      goal: { item: 'stick', count: 1 },
      check: (world) => world.biome === 'plains',
    });
    expect(task.check(task.createWorld())).toBe(true);
  });

  it('builds a fresh world every time', () => {
    const task = requireTask('planks-from-logs');
    const first = task.createWorld();
    first.mine('oak_log', 8);
    expect(task.createWorld().resourceCount('oak_log')).toBe(8);
  });

  it('refuses a nonsense goal or budget', () => {
    expect(() =>
      defineTask({ id: 't', description: 'd', goal: { item: 'x', count: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      defineTask({
        id: 't',
        description: 'd',
        goal: { item: 'x', count: 1 },
        stepBudget: -3,
      }),
    ).toThrow(RangeError);
  });

  it('has a unique id per starter task', () => {
    const ids = STARTER_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('runTask control flow', () => {
  const task = requireTask('planks-from-logs');

  it('reaches the goal and counts the steps it took', () => {
    const result = runTask(
      task,
      scripted(
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
      ),
    );
    expect(result.outcome).toBe('goal-reached');
    expect(result.success).toBe(true);
    expect(result.stepsUsed).toBe(2);
    expect(result.refusal).toBeUndefined();
  });

  it('checks the goal before spending a step', () => {
    const already = defineTask({
      id: 'already-done',
      description: 'The goal is met before the policy acts.',
      goal: { item: 'stick', count: 1 },
      startingInventory: { stick: 4 },
    });
    const result = runTask(already, () => {
      throw new Error('policy should never be consulted');
    });
    expect(result.outcome).toBe('goal-reached');
    expect(result.stepsUsed).toBe(0);
  });

  it('enforces the step budget', () => {
    const result = runTask(
      task,
      () => ({ kind: 'mine', resource: 'oak_log', count: 1 }),
      { stepBudget: 3 },
    );
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.success).toBe(false);
    expect(result.stepsUsed).toBe(3);
  });

  it('prefers the task budget when options do not override it', () => {
    const result = runTask(task, () => ({ kind: 'stop' }));
    expect(task.stepBudget).toBe(8);
    expect(result.stepsUsed).toBe(0);
  });

  it('records every action it took', () => {
    const result = runTask(
      task,
      scripted(
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
      ),
    );
    expect(result.log.map((r) => r.action.kind)).toEqual(['mine', 'craft']);
    expect(result.log.every((r) => r.result?.ok)).toBe(true);
  });

  it('keeps the last refusal and carries on by default', () => {
    const result = runTask(
      task,
      scripted(
        { kind: 'craft', item: 'oak_planks', count: 4 },
        { kind: 'mine', resource: 'oak_log', count: 1 },
        { kind: 'craft', item: 'oak_planks', count: 4 },
      ),
    );
    expect(result.outcome).toBe('goal-reached');
    expect(result.success).toBe(true);
    expect(result.refusal?.reason).toBe('missing-ingredient');
  });

  it('ends on the first refusal when told to', () => {
    const result = runTask(
      task,
      scripted({ kind: 'craft', item: 'oak_planks', count: 4 }),
      { stopOnRefusal: true },
    );
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.success).toBe(false);
    expect(result.refusal?.reason).toBe('missing-ingredient');
    expect(result.stepsUsed).toBe(1);
  });

  it('surfaces a policy that throws rather than swallowing it', () => {
    const result = runTask(task, () => {
      throw new Error('planner blew up');
    });
    expect(result.outcome).toBe('policy-error');
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('planner blew up');
  });

  it('treats giving up on a solvable task as a failure', () => {
    const result = runTask(task, () => ({ kind: 'stop', reason: 'too hard' }));
    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('too hard');
  });

  it('resource exhaustion is reported, not fatal', () => {
    const scarce = defineTask({
      id: 'one-log',
      description: 'A single log and a demand for two.',
      goal: { item: 'oak_planks', count: 8 },
      resources: { oak_log: 1 },
      stepBudget: 4,
    });
    const result = runTask(
      scarce,
      () => ({ kind: 'mine', resource: 'oak_log', count: 2 }),
      { stopOnRefusal: true },
    );
    expect(result.refusal?.reason).toBe('resource-exhausted');
    expect(result.refusal?.shortfall).toEqual({
      item: 'oak_log',
      needed: 2,
      held: 1,
    });
  });
});

describe('spatial actions through the runner', () => {
  it('places and moves, and a task can check the result', () => {
    const shelter = defineTask({
      id: 'shelter',
      description: 'Seal yourself in with six cobblestone.',
      goal: { item: 'cobblestone', count: 6 },
      startingInventory: { cobblestone: 6 },
      agent: { x: 0, y: 64, z: 0 },
      stepBudget: 8,
      check: (world) => world.enclosed,
    });
    const result = runTask(
      shelter,
      scripted(
        { kind: 'place', block: 'cobblestone', at: { x: 1, y: 64, z: 0 } },
        { kind: 'place', block: 'cobblestone', at: { x: -1, y: 64, z: 0 } },
        { kind: 'place', block: 'cobblestone', at: { x: 0, y: 65, z: 0 } },
        { kind: 'place', block: 'cobblestone', at: { x: 0, y: 63, z: 0 } },
        { kind: 'place', block: 'cobblestone', at: { x: 0, y: 64, z: 1 } },
        { kind: 'place', block: 'cobblestone', at: { x: 0, y: 64, z: -1 } },
      ),
    );
    expect(result.outcome).toBe('goal-reached');
    expect(result.stepsUsed).toBe(6);
    expect(result.world.inventory.count('cobblestone')).toBe(0);
  });

  it('reports a refused placement without ending the run', () => {
    const task = defineTask({
      id: 'place-nothing',
      description: 'Place a block that is not held.',
      goal: { item: 'cobblestone', count: 1 },
      agent: { x: 0, y: 64, z: 0 },
      stepBudget: 2,
    });
    const result = runTask(
      task,
      scripted({
        kind: 'place',
        block: 'cobblestone',
        at: { x: 1, y: 64, z: 0 },
      }),
    );
    expect(result.refusal?.reason).toBe('item-not-held');
    expect(result.log[0]?.action.kind).toBe('place');
  });

  it('moves the agent one step at a time', () => {
    const task = defineTask({
      id: 'climb',
      description: 'Stand two blocks higher than you started.',
      goal: { item: 'stick', count: 1 },
      agent: { x: 0, y: 64, z: 0 },
      stepBudget: 4,
      check: (world) => world.agentPosition.y >= 66,
    });
    const result = runTask(
      task,
      scripted(
        { kind: 'move', to: { x: 0, y: 65, z: 0 } },
        { kind: 'move', to: { x: 0, y: 66, z: 0 } },
      ),
    );
    expect(result.outcome).toBe('goal-reached');
    expect(result.world.agentPosition).toEqual({ x: 0, y: 66, z: 0 });
  });
});

describe('impossible tasks', () => {
  it('scores a refusal as success', () => {
    const task = requireTask('pickaxe-without-a-table');
    expect(task.impossible).toBe(true);
    const result = runTask(task, () => ({
      kind: 'stop',
      reason: 'no crafting table, and every pickaxe recipe needs 3x3',
    }));
    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(true);
    expect(result.stepsUsed).toBe(0);
  });

  it('scores flailing until the budget runs out as failure', () => {
    const task = requireTask('pickaxe-without-a-table');
    const result = runTask(task, () => ({
      kind: 'craft',
      item: 'wooden_pickaxe',
      count: 1,
    }));
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.success).toBe(false);
    expect(result.stepsUsed).toBe(task.stepBudget);
    expect(result.refusal?.reason).toBe('no-crafting-table');
  });

  it('terminates rather than looping on an unreachable goal', () => {
    const task = requireTask('diamond-from-a-forest');
    const result = runTask(task, planningPolicy(task.goal));
    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(true);
    expect(result.stopReason).toContain('diamond_ore');
  });

  it('notices when there is not quite enough wood', () => {
    const task = requireTask('not-enough-wood');
    const result = runTask(task, planningPolicy(task.goal));
    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(true);
    expect(result.stopReason).toContain('oak_log');
  });
});

describe('planningPolicy as a baseline', () => {
  it('solves every solvable starter task and refuses every impossible one', () => {
    for (const task of STARTER_TASKS) {
      const result = runTask(task, planningPolicy(task.goal));
      expect(
        { id: task.id, success: result.success },
        `${task.id} ended as ${result.outcome} (${result.stopReason ?? ''})`,
      ).toEqual({ id: task.id, success: true });
      expect(result.outcome).toBe(task.impossible ? 'refused' : 'goal-reached');
    }
  });

  it('walks the whole wood chain from an empty inventory', () => {
    const task = requireTask('wooden-pickaxe');
    const result = runTask(task, planningPolicy(task.goal));
    expect(result.success).toBe(true);
    expect(result.log.map((r) => r.action.kind)).toEqual([
      'mine',
      'craft',
      'craft',
      'craft',
    ]);
    expect(result.world.inventory.count('wooden_pickaxe')).toBe(1);
  });

  it('is deterministic: the same task and policy give the same log', () => {
    const task = requireTask('wooden-pickaxe');
    const a = runTask(task, planningPolicy(task.goal));
    const b = runTask(task, planningPolicy(task.goal));
    expect(a.log.map((r) => r.action)).toEqual(b.log.map((r) => r.action));
    expect(a.stepsUsed).toBe(b.stepsUsed);
  });

  it('refuses to smelt without a furnace instead of retrying forever', () => {
    const noFurnace = defineTask({
      id: 'no-furnace',
      description: 'Raw iron and nothing to cook it in.',
      goal: { item: 'iron_ingot', count: 1 },
      startingInventory: { raw_iron: 1 },
      furnace: false,
      impossible: true,
      stepBudget: 6,
    });
    const result = runTask(noFurnace, planningPolicy(noFurnace.goal));
    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(true);
    expect(result.stopReason).toBe('no furnace in reach');
  });
});
