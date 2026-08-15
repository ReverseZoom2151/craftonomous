import { describe, expect, it } from 'vitest';
import { AgentMemory, createSummariser } from '../../src/agent/memory.js';
import { ManualClock } from '../../src/runtime/clock.js';

const mem = (
  options: Partial<{ budgetChars: number; keepRecent: number }> = {},
) => {
  const clock = new ManualClock(1000);
  return {
    clock,
    memory: new AgentMemory({
      clock,
      budgetChars: options.budgetChars ?? 200,
      keepRecent: options.keepRecent ?? 2,
    }),
  };
};

describe('turns', () => {
  it('appends turns with the injected clock', () => {
    const { memory, clock } = mem();
    memory.append('user', 'hello');
    clock.advance(500);
    memory.append('agent', 'hi');

    expect(memory.turns().map((t) => t.at)).toEqual([1000, 1500]);
    expect(memory.turns().map((t) => t.role)).toEqual(['user', 'agent']);
  });

  it('keeps everything while inside budget', () => {
    const { memory } = mem({ budgetChars: 10_000 });
    for (let i = 0; i < 20; i++) memory.append('agent', `turn ${i}`);

    expect(memory.turns()).toHaveLength(20);
    expect(memory.summary()).toBeUndefined();
    expect(memory.foldedCount).toBe(0);
  });
});

describe('rolling summarisation', () => {
  it('folds the oldest turns into a summary rather than dropping them', () => {
    const { memory } = mem({ budgetChars: 120, keepRecent: 2 });
    memory.append('user', 'the goal is to find diamonds below y 12');
    for (let i = 0; i < 12; i++) {
      memory.append('action', `mined stone at depth ${i} which took a while`);
    }

    const summary = memory.summary();
    expect(summary).toBeDefined();
    // The first turn is the one nothing else can recover. It must survive.
    expect(summary).toContain('the goal is to find diamonds');
    expect(memory.foldedCount).toBeGreaterThan(0);
    expect(memory.turns().length).toBeGreaterThanOrEqual(2);
  });

  it('keeps live turns inside the budget', () => {
    const { memory } = mem({ budgetChars: 120, keepRecent: 1 });
    for (let i = 0; i < 50; i++) {
      memory.append('outcome', `step ${i} finished with a fairly long message`);
    }

    expect(memory.liveChars).toBeLessThanOrEqual(120);
    expect(memory.foldedCount).toBe(50 - memory.turns().length);
  });

  it('bounds the summary itself, marking what it condensed', () => {
    const summarise = createSummariser({ maxChars: 200, maxTurnChars: 40 });
    const { clock } = mem();
    const memory = new AgentMemory({
      clock,
      budgetChars: 50,
      keepRecent: 1,
      summarise,
    });
    for (let i = 0; i < 60; i++) {
      memory.append('action', `did thing number ${i} in a verbose way indeed`);
    }

    const summary = memory.summary() ?? '';
    expect(summary.length).toBeLessThan(400);
    expect(summary).toMatch(/\[\d+ intervening turns condensed\]/);
    // Only one condensation marker, however many rounds of folding happened.
    expect(summary.match(/intervening turns condensed/g)).toHaveLength(1);
  });

  it('compacts on demand', () => {
    const { memory } = mem({ budgetChars: 10_000, keepRecent: 1 });
    memory.append('user', 'first');
    memory.append('agent', 'second');
    memory.append('agent', 'third');

    memory.compact();

    expect(memory.turns()).toHaveLength(1);
    expect(memory.summary()).toContain('first');
  });
});

describe('durable knowledge', () => {
  it('keeps facts and named locations out of summarisation', () => {
    const { memory } = mem({ budgetChars: 20, keepRecent: 0 });
    memory.learn('zombies burn at dawn', 'observation');
    memory.remember('base', { x: 10, y: 64, z: -20 }, 'the first shelter');

    for (let i = 0; i < 40; i++)
      memory.append('action', `noise ${i} padding text`);

    expect(memory.facts()).toHaveLength(1);
    expect(memory.facts()[0]?.text).toBe('zombies burn at dawn');
    expect(memory.location('base')?.position).toEqual({ x: 10, y: 64, z: -20 });
    expect(memory.transcript()).toContain('zombies burn at dawn');
    expect(memory.transcript()).toContain('base: (10,64,-20)');
  });

  it('caps the fact list', () => {
    const clock = new ManualClock(0);
    const memory = new AgentMemory({ clock, maxFacts: 3 });
    for (let i = 0; i < 10; i++) memory.learn(`fact ${i}`);

    expect(memory.facts()).toHaveLength(3);
    expect(memory.facts()[0]?.text).toBe('fact 7');
  });

  it('replaces a re-named location and can forget one', () => {
    const { memory } = mem();
    memory.remember('mine', { x: 1, y: 1, z: 1 });
    memory.remember('mine', { x: 2, y: 2, z: 2 });

    expect(memory.locations()).toHaveLength(1);
    expect(memory.location('mine')?.position.x).toBe(2);
    expect(memory.forget('mine')).toBe(true);
    expect(memory.locations()).toHaveLength(0);
  });

  it('survives an episode reset unless asked otherwise', () => {
    const { memory } = mem();
    memory.append('user', 'go');
    memory.learn('lava is bad');

    memory.reset();
    expect(memory.turns()).toHaveLength(0);
    expect(memory.facts()).toHaveLength(1);

    memory.reset(true);
    expect(memory.facts()).toHaveLength(0);
  });

  it('exposes a snapshot for policies', () => {
    const { memory } = mem();
    memory.append('user', 'dig down');
    memory.learn('never dig straight down');

    const snap = memory.snapshot();
    expect(snap.turns).toHaveLength(1);
    expect(snap.facts).toHaveLength(1);
    expect(snap.summary).toBeUndefined();
  });
});
