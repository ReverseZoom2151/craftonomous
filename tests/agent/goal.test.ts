import { describe, expect, it } from 'vitest';
import { GoalDepthExceeded, GoalStack } from '../../src/agent/goal.js';
import { ManualClock } from '../../src/runtime/clock.js';

const stack = (options: { historyLimit?: number; maxDepth?: number } = {}) => {
  const clock = new ManualClock(100);
  return {
    clock,
    goals: new GoalStack({
      clock,
      ...(options.historyLimit === undefined
        ? {}
        : { historyLimit: options.historyLimit }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    }),
  };
};

describe('push and current', () => {
  it('starts empty', () => {
    const { goals } = stack();
    expect(goals.current()).toBeUndefined();
    expect(goals.isEmpty).toBe(true);
    expect(goals.depth).toBe(0);
  });

  it('makes the newest goal current and remembers its parent', () => {
    const { goals } = stack();
    const root = goals.push('gather 3 iron_ore');
    const sub = goals.push('craft a stone pickaxe');

    expect(goals.current()?.id).toBe(sub.id);
    expect(sub.parentId).toBe(root.id);
    expect(goals.depth).toBe(2);
    expect(goals.stack().map((g) => g.description)).toEqual([
      'gather 3 iron_ore',
      'craft a stone pickaxe',
    ]);
  });

  it('stamps creation time from the injected clock', () => {
    const { goals, clock } = stack();
    clock.advance(400);
    expect(goals.push('explore').createdAt).toBe(500);
  });

  it('refuses to nest past the depth limit', () => {
    const { goals } = stack({ maxDepth: 2 });
    goals.push('a');
    goals.push('b');
    expect(() => goals.push('c')).toThrow(GoalDepthExceeded);
    expect(goals.depth).toBe(2);
  });
});

describe('resolution', () => {
  it('pops back to the parent when a sub-goal is achieved', () => {
    const { goals } = stack();
    goals.push('gather 3 iron_ore');
    goals.push('craft a stone pickaxe');

    const done = goals.achieve('pickaxe in hand');

    expect(done?.status).toBe('achieved');
    expect(done?.reason).toBe('pickaxe in hand');
    expect(goals.current()?.description).toBe('gather 3 iron_ore');
  });

  it('records a reason when abandoned', () => {
    const { goals, clock } = stack();
    goals.push('mine obsidian');
    clock.advance(50);

    const abandoned = goals.abandon('no diamond pickaxe and no way to get one');

    expect(abandoned?.status).toBe('abandoned');
    expect(abandoned?.reason).toContain('no diamond pickaxe');
    expect(abandoned?.resolvedAt).toBe(150);
    expect(goals.isEmpty).toBe(true);
  });

  it('resolves to undefined on an empty stack', () => {
    const { goals } = stack();
    expect(goals.achieve()).toBeUndefined();
    expect(goals.abandon('nothing to abandon')).toBeUndefined();
    expect(goals.pop()).toBeUndefined();
  });

  it('abandons everything at once', () => {
    const { goals } = stack();
    goals.push('a');
    goals.push('b');
    goals.push('c');

    const dropped = goals.abandonAll('run ended');

    expect(dropped.map((g) => g.description)).toEqual(['c', 'b', 'a']);
    expect(goals.isEmpty).toBe(true);
    expect(goals.history()).toHaveLength(3);
  });
});

describe('history', () => {
  it('keeps what was tried, in order, so a run can be reported', () => {
    const { goals } = stack();
    goals.push('find wood');
    goals.achieve('collected 8 oak_log');
    goals.push('find stone');
    goals.abandon('daylight ran out');

    expect(
      goals.history().map((g) => [g.description, g.status, g.reason]),
    ).toEqual([
      ['find wood', 'achieved', 'collected 8 oak_log'],
      ['find stone', 'abandoned', 'daylight ran out'],
    ]);
  });

  it('is bounded', () => {
    const { goals } = stack({ historyLimit: 3 });
    for (let i = 0; i < 10; i++) {
      goals.push(`goal ${i}`);
      goals.achieve('done');
    }

    const history = goals.history();
    expect(history).toHaveLength(3);
    expect(history[0]?.description).toBe('goal 7');
  });

  it('marks a bare pop as abandoned without a reason given', () => {
    const { goals } = stack();
    goals.push('wander');
    goals.pop();

    expect(goals.history()[0]?.status).toBe('abandoned');
    expect(goals.history()[0]?.reason).toContain('without a reason');
  });

  it('describes the stack and recent history', () => {
    const { goals } = stack();
    goals.push('survive the night');
    goals.push('build a shelter');

    const text = goals.describe();
    expect(text).toContain('survive the night');
    expect(text).toContain('→ build a shelter');

    goals.achieve('walls up');
    expect(goals.describe()).toContain('achieved: build a shelter (walls up)');
  });

  it('says so when there is no goal', () => {
    expect(stack().goals.describe()).toBe('no active goal');
  });
});
