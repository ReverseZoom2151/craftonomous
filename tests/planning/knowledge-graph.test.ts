import { describe, expect, it } from 'vitest';
import type { Observation } from '../../src/planning/knowledge-graph.js';
import { KnowledgeGraph, edgeKey } from '../../src/planning/knowledge-graph.js';

const FURNACE = {
  from: 'iron_ore',
  to: 'iron_ingot',
  relation: 'produces',
} as const;
const WRONG = {
  from: 'iron_ore',
  to: 'iron_ingot_by_crafting',
  relation: 'produces',
} as const;

function seeded(): KnowledgeGraph {
  return new KnowledgeGraph().hypothesise([
    { ...FURNACE, confidence: 0.6 },
    // The bad prior: something a model asserted confidently and wrongly.
    { ...WRONG, confidence: 0.9 },
    { from: 'iron_ingot', to: 'iron_pickaxe', relation: 'requires' },
  ]);
}

const repeat = (o: Observation, n: number): Observation[] =>
  Array.from({ length: n }, () => o);

describe('hypothesise', () => {
  it('seeds edges at their stated prior, defaulting to a shrug', () => {
    const g = seeded();
    expect(g.size).toBe(3);
    expect(g.confidenceOf(FURNACE)).toBeCloseTo(0.6);
    expect(g.confidenceOf(WRONG)).toBeCloseTo(0.9);
    expect(
      g.confidenceOf({
        from: 'iron_ingot',
        to: 'iron_pickaxe',
        relation: 'requires',
      }),
    ).toBeCloseTo(0.5);
  });

  it('marks seeded edges as hypotheses with a recorded prior', () => {
    const e = seeded().edge(FURNACE);
    expect(e?.source).toBe('hypothesis');
    expect(e?.prior).toBeCloseTo(0.6);
    expect(e?.supporting).toBe(0);
    expect(e?.contradicting).toBe(0);
  });

  it('rejects a prior of exactly 0 or 1, which no evidence could move', () => {
    expect(() =>
      new KnowledgeGraph().hypothesise([{ ...FURNACE, confidence: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      new KnowledgeGraph().hypothesise([{ ...FURNACE, confidence: 0 }]),
    ).toThrow(RangeError);
  });

  it('re-seeding resets rather than accumulating', () => {
    const g = seeded();
    g.correct({ ...FURNACE, held: true });
    g.hypothesise([{ ...FURNACE, confidence: 0.6 }]);
    expect(g.confidenceOf(FURNACE)).toBeCloseTo(0.6);
    expect(g.edge(FURNACE)?.supporting).toBe(0);
  });

  it('reports an unknown edge as undefined, not as disbelief', () => {
    expect(
      seeded().confidenceOf({ from: 'a', to: 'b', relation: 'produces' }),
    ).toBeUndefined();
  });
});

describe('correct', () => {
  it('raises confidence on supporting evidence and lowers it on contrary', () => {
    const g = seeded();
    const up = g.correct({ ...FURNACE, held: true });
    expect(up.confidence).toBeGreaterThan(0.6);
    expect(up.supporting).toBe(1);
    const down = g.correct({ ...FURNACE, held: false });
    expect(down.confidence).toBeCloseTo(0.6);
    expect(down.contradicting).toBe(1);
  });

  it('never leaves the open unit interval', () => {
    const g = seeded();
    g.correctAll(repeat({ ...FURNACE, held: true }, 200));
    const high = g.confidenceOf(FURNACE) as number;
    expect(high).toBeLessThan(1);
    expect(high).toBeGreaterThan(0.99);
    g.correctAll(repeat({ ...FURNACE, held: false }, 400));
    const low = g.confidenceOf(FURNACE) as number;
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.01);
  });

  it('weights an ambiguous observation less than a plain one', () => {
    const strong = new KnowledgeGraph().hypothesise([FURNACE]);
    const weak = new KnowledgeGraph().hypothesise([FURNACE]);
    strong.correct({ ...FURNACE, held: false });
    weak.correct({ ...FURNACE, held: false, weight: 0.25 });
    expect(weak.confidenceOf(FURNACE)).toBeGreaterThan(
      strong.confidenceOf(FURNACE) as number,
    );
  });

  it('rejects a non-positive weight', () => {
    const g = seeded();
    expect(() => g.correct({ ...FURNACE, held: true, weight: 0 })).toThrow(
      RangeError,
    );
  });

  it('discovers an edge nobody hypothesised', () => {
    const g = seeded();
    const discovered = {
      from: 'raw_iron',
      to: 'iron_ingot',
      relation: 'produces',
    } as const;
    g.correctAll(repeat({ ...discovered, held: true }, 3));
    const e = g.edge(discovered);
    expect(e?.source).toBe('observation');
    expect(e?.prior).toBeCloseTo(0.5);
    expect(e?.confidence).toBeGreaterThan(0.9);
    expect(g.believed().edge(discovered)).toBeDefined();
  });

  it('is order-independent for the same body of evidence', () => {
    const a = new KnowledgeGraph().hypothesise([
      { ...FURNACE, confidence: 0.7 },
    ]);
    const b = new KnowledgeGraph().hypothesise([
      { ...FURNACE, confidence: 0.7 },
    ]);
    a.correctAll([
      { ...FURNACE, held: true },
      { ...FURNACE, held: false },
      { ...FURNACE, held: true },
    ]);
    b.correctAll([
      { ...FURNACE, held: false },
      { ...FURNACE, held: true },
      { ...FURNACE, held: true },
    ]);
    expect(a.confidenceOf(FURNACE)).toBeCloseTo(
      b.confidenceOf(FURNACE) as number,
    );
  });
});

describe('unlearning a wrong prior', () => {
  it('drops a confidently seeded edge below threshold under contrary evidence', () => {
    const g = seeded();
    expect(g.believed().edge(WRONG)).toBeDefined();

    // Every attempt to craft an ingot from ore fails. The prior said 0.9.
    const trail: number[] = [];
    for (let i = 0; i < 6; i++) {
      trail.push(g.correct({ ...WRONG, held: false }).confidence);
    }

    // Monotone decline, no plateau above the threshold.
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i] as number).toBeLessThan(trail[i - 1] as number);
    }
    expect(g.confidenceOf(WRONG)).toBeLessThan(0.5);
    expect(g.believed().edge(WRONG)).toBeUndefined();
    expect(g.unlearned().map(edgeKey)).toEqual([edgeKey(WRONG)]);
  });

  it('keeps the correct edge while unlearning the wrong one', () => {
    const g = seeded();
    g.correctAll([
      ...repeat({ ...WRONG, held: false }, 8),
      ...repeat({ ...FURNACE, held: true }, 3),
    ]);
    const believed = g.believed(0.6);
    expect(believed.edge(FURNACE)).toBeDefined();
    expect(believed.edge(WRONG)).toBeUndefined();
    expect(believed.size).toBe(1);
    // The original graph still has the edge, with its history intact.
    expect(g.size).toBe(3);
    expect(g.edge(WRONG)?.contradicting).toBe(8);
    expect(g.edge(WRONG)?.prior).toBeCloseTo(0.9);
  });

  it('takes more evidence to dislodge a stronger prior', () => {
    const cost = (prior: number): number => {
      const g = new KnowledgeGraph().hypothesise([
        { ...WRONG, confidence: prior },
      ]);
      let n = 0;
      while ((g.confidenceOf(WRONG) as number) >= 0.5 && n < 100) {
        g.correct({ ...WRONG, held: false });
        n += 1;
      }
      return n;
    };
    expect(cost(0.99)).toBeGreaterThan(cost(0.6));
    expect(cost(0.99)).toBeLessThan(100);
  });

  it('a slower learning rate needs more evidence but still converges', () => {
    const slow = new KnowledgeGraph({ learningRate: 0.1 }).hypothesise([
      { ...WRONG, confidence: 0.9 },
    ]);
    slow.correctAll(repeat({ ...WRONG, held: false }, 10));
    expect(slow.confidenceOf(WRONG)).toBeGreaterThan(0.5);
    slow.correctAll(repeat({ ...WRONG, held: false }, 40));
    expect(slow.confidenceOf(WRONG)).toBeLessThan(0.5);
  });

  it('rejects a non-positive learning rate', () => {
    expect(() => new KnowledgeGraph({ learningRate: 0 })).toThrow(RangeError);
  });
});

describe('believed', () => {
  it('honours an explicit threshold and returns a usable graph', () => {
    const g = seeded();
    expect(g.believed(0.95).size).toBe(0);
    expect(g.believed(0.8).size).toBe(1);
    expect(g.believed(0.5).size).toBe(3);
    const strict = g.believed(0.8);
    expect(strict.edges().map(edgeKey)).toEqual([edgeKey(WRONG)]);
  });

  it('does not alias the source graph', () => {
    const g = seeded();
    const view = g.believed(0.5);
    g.correctAll(repeat({ ...WRONG, held: false }, 10));
    expect(view.confidenceOf(WRONG)).toBeCloseTo(0.9);
    expect(g.confidenceOf(WRONG) as number).toBeLessThan(0.1);
  });
});

describe('queries and rendering', () => {
  it('answers what produces an item and what an item requires', () => {
    const g = seeded();
    g.correctAll(repeat({ ...FURNACE, held: true }, 3));
    expect(g.producedBy('iron_ingot').map((e) => e.from)).toEqual(['iron_ore']);
    expect(g.requirementsFor('iron_pickaxe')).toEqual([]);
    expect(g.requirementsFor('iron_ingot').map((e) => e.to)).toEqual([
      'iron_pickaxe',
    ]);
  });

  it('drops a query answer once the edge is unlearned', () => {
    const g = seeded();
    expect(g.producedBy('iron_ingot_by_crafting')).toHaveLength(1);
    g.correctAll(repeat({ ...WRONG, held: false }, 10));
    expect(g.producedBy('iron_ingot_by_crafting')).toEqual([]);
  });

  it('lists edges most confident first', () => {
    const keys = seeded().edges().map(edgeKey);
    expect(keys[0]).toBe(edgeKey(WRONG));
    expect(keys).toHaveLength(3);
  });

  it('renders only believed edges as mermaid', () => {
    const g = seeded();
    const out = g.toMermaid(0.8);
    expect(out.startsWith('flowchart LR')).toBe(true);
    expect(out).toContain('iron_ingot_by_crafting');
    expect(out).toContain('produces 0.90');
    expect(out).not.toContain('iron_pickaxe');
  });
});
