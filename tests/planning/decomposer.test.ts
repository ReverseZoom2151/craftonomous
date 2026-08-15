import { describe, expect, it } from 'vitest';
import type { Expander } from '../../src/planning/decomposer.js';
import { decompose, normaliseGoal } from '../../src/planning/decomposer.js';

/** A table-driven fake standing in for the LLM. Records every call. */
function tableExpander(table: Readonly<Record<string, readonly string[]>>): {
  expand: Expander;
  calls: string[];
  contexts: { goal: string; depth: number; known: number }[];
} {
  const calls: string[] = [];
  const contexts: { goal: string; depth: number; known: number }[] = [];
  const expand: Expander = (goal, ctx) => {
    calls.push(goal);
    contexts.push({ goal, depth: ctx.depth, known: ctx.known.length });
    return Promise.resolve(table[goal] ?? []);
  };
  return { expand, calls, contexts };
}

/** Fans out forever: the case a bounded planner has to survive. */
const infinite: Expander = (goal) =>
  Promise.resolve([`${goal} / 1`, `${goal} / 2`, `${goal} / 3`]);

const descriptions = (r: {
  graph: { nodes(): readonly { description: string }[] };
}): string[] =>
  r.graph
    .nodes()
    .map((n) => n.description)
    .sort();

describe('normaliseGoal', () => {
  it('ignores case, surrounding space, runs of space and trailing stops', () => {
    expect(normaliseGoal('  Mine   Iron Ore.  ')).toBe('mine iron ore');
    expect(normaliseGoal('mine iron ore')).toBe(
      normaliseGoal('Mine Iron Ore!'),
    );
  });
});

describe('decompose builds a valid plan', () => {
  it('splices each expansion into the graph, leaving a runnable DAG', async () => {
    const { expand } = tableExpander({
      'build a shelter': ['gather wood', 'place walls'],
      'gather wood': ['find a tree', 'chop it'],
    });
    const r = await decompose('build a shelter', expand);

    expect(r.graph.hasCycle()).toBe(false);
    expect(descriptions(r)).toEqual(['chop it', 'find a tree', 'place walls']);
    // Sequential by default: the chain is respected across the splice.
    const order = r.graph.topologicalOrder();
    const at = (d: string): number =>
      order.indexOf(r.graph.nodes().find((n) => n.description === d)?.id ?? '');
    expect(at('find a tree')).toBeLessThan(at('chop it'));
    expect(at('chop it')).toBeLessThan(at('place walls'));
    expect(r.graph.readyFrontier().map((n) => n.description)).toEqual([
      'find a tree',
    ]);
    expect(r.stoppedBecause).toBe('exhausted');
  });

  it('leaves subtasks independent when asked for parallel order', async () => {
    const { expand } = tableExpander({ goal: ['a', 'b', 'c'] });
    const r = await decompose('goal', expand, { subtaskOrder: 'parallel' });
    expect(
      r.graph
        .readyFrontier()
        .map((n) => n.description)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('treats an empty expansion as primitive and keeps the node', async () => {
    const { expand, calls } = tableExpander({});
    const r = await decompose('punch a tree', expand);
    expect(r.graph.size).toBe(1);
    expect(r.graph.node(r.graph.nodes()[0]?.id ?? '')?.description).toBe(
      'punch a tree',
    );
    expect(calls).toEqual(['punch a tree']);
    expect(r.expansions).toBe(1);
  });

  it('stamps the assignee onto generated nodes', async () => {
    const { expand } = tableExpander({ goal: ['a', 'b'] });
    const r = await decompose('goal', expand, { assignee: 'bot-1' });
    expect(r.graph.nodes().every((n) => n.assignee === 'bot-1')).toBe(true);
  });

  it('passes depth and the known-goal set to the expander', async () => {
    const { expand, contexts } = tableExpander({
      goal: ['a'],
      a: ['b'],
    });
    await decompose('goal', expand);
    expect(contexts.map((c) => [c.goal, c.depth])).toEqual([
      ['goal', 0],
      ['a', 1],
      // `b` is asked too, and answers with nothing: that is how a leaf is
      // recognised, rather than by the planner guessing.
      ['b', 2],
    ]);
    expect(contexts[0]?.known).toBe(1);
    expect(contexts[1]?.known).toBeGreaterThanOrEqual(1);
  });

  it('rejects a lookahead below one', async () => {
    await expect(decompose('goal', infinite, { lookahead: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('bounded lookahead', () => {
  it('expands at most `lookahead` nodes per round', async () => {
    const r = await decompose('goal', infinite, {
      lookahead: 2,
      maxRounds: 3,
      maxDepth: 10,
    });
    // Round 1 has only the root available; rounds 2 and 3 are capped at 2.
    expect(r.rounds).toBe(3);
    expect(r.expansions).toBe(5);
    expect(r.expansions).toBeLessThanOrEqual(r.rounds * 2);
    expect(r.stoppedBecause).toBe('max-rounds');
  });

  it('leaves the rest of the tree unplanned rather than planning it all', async () => {
    const r = await decompose('goal', infinite, {
      lookahead: 1,
      maxRounds: 2,
      maxDepth: 10,
    });
    expect(r.expansions).toBe(2);
    expect(r.pending.length).toBeGreaterThan(0);
    // Every pending id is a real node, so planning can resume from here.
    expect(r.pending.every((id) => r.graph.has(id))).toBe(true);
    expect(r.graph.hasCycle()).toBe(false);
  });

  it('a larger lookahead reaches further in the same number of rounds', async () => {
    const narrow = await decompose('goal', infinite, {
      lookahead: 1,
      maxRounds: 4,
      maxDepth: 10,
    });
    const wide = await decompose('goal', infinite, {
      lookahead: 5,
      maxRounds: 4,
      maxDepth: 10,
    });
    expect(wide.expansions).toBeGreaterThan(narrow.expansions);
    expect(wide.graph.size).toBeGreaterThan(narrow.graph.size);
  });
});

describe('termination guards', () => {
  it('terminates when the expander restates its own goal', async () => {
    const selfish: Expander = (goal) => Promise.resolve([goal]);
    const r = await decompose('mine iron', selfish, { maxRounds: 100 });
    expect(r.rounds).toBe(1);
    expect(r.graph.size).toBe(1);
    expect(r.repeatsDropped).toBe(1);
    expect(r.stoppedBecause).toBe('exhausted');
  });

  it('terminates when the expander restates its goal in different case', async () => {
    const sloppy: Expander = (goal) =>
      Promise.resolve([`  ${goal.toUpperCase()}. `]);
    const r = await decompose('mine iron', sloppy, { maxRounds: 100 });
    expect(r.graph.size).toBe(1);
    expect(r.repeatsDropped).toBe(1);
  });

  it('drops a subgoal already present elsewhere in the plan', async () => {
    const { expand } = tableExpander({
      goal: ['left', 'right'],
      left: ['shared work'],
      right: ['shared work'],
    });
    const r = await decompose('goal', expand);
    expect(descriptions(r)).toEqual(['right', 'shared work']);
    expect(r.repeatsDropped).toBe(1);
    expect(r.graph.hasCycle()).toBe(false);
  });

  it('drops repeats within a single expansion', async () => {
    const { expand } = tableExpander({ goal: ['a', 'A ', 'b', 'a.'] });
    const r = await decompose('goal', expand);
    expect(descriptions(r)).toEqual(['a', 'b']);
    expect(r.repeatsDropped).toBe(2);
  });

  it('stops at the depth cap', async () => {
    const r = await decompose('goal', infinite, { maxDepth: 1 });
    expect(r.stoppedBecause).toBe('max-depth');
    expect(r.graph.size).toBe(3);
    expect(r.expansions).toBe(1);
  });

  it('stops at the node cap without truncating a decomposition', async () => {
    const r = await decompose('goal', infinite, {
      maxNodes: 4,
      maxRounds: 100,
      maxDepth: 100,
    });
    expect(r.stoppedBecause).toBe('max-nodes');
    expect(r.graph.size).toBeLessThanOrEqual(4);
    // A node whose children would not fit stays whole rather than half-planned.
    expect(r.graph.size).toBe(3);
  });

  it('terminates on an infinite expander under every default', async () => {
    const r = await decompose('goal', infinite);
    expect(r.graph.size).toBeLessThanOrEqual(64);
    expect(r.graph.hasCycle()).toBe(false);
    expect(['max-nodes', 'max-rounds', 'max-depth']).toContain(
      r.stoppedBecause,
    );
  });

  it('ignores blank subgoals', async () => {
    const { expand } = tableExpander({ goal: ['', '   ', 'real work'] });
    const r = await decompose('goal', expand);
    expect(descriptions(r)).toEqual(['real work']);
  });
});
