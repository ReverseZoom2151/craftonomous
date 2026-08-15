import { describe, expect, it } from 'vitest';
import { CycleError, TaskGraph } from '../../src/planning/dag.js';

function chain(): TaskGraph {
  return TaskGraph.from([
    { id: 'wood', description: 'gather wood' },
    { id: 'planks', description: 'craft planks', dependencies: ['wood'] },
    { id: 'table', description: 'craft table', dependencies: ['planks'] },
  ]);
}

describe('TaskGraph basics', () => {
  it('rejects duplicate ids and unknown references', () => {
    const g = chain();
    expect(() => g.addNode({ id: 'wood', description: 'again' })).toThrow(
      /duplicate/,
    );
    expect(() => g.addEdge('wood', 'nope')).toThrow(/unknown task id/);
  });

  it('rejects a self-edge outright', () => {
    const g = chain();
    expect(() => g.addEdge('wood', 'wood')).toThrow(CycleError);
  });

  it('keeps optional fields absent rather than undefined', () => {
    const g = TaskGraph.from([{ id: 'a', description: 'a' }]);
    const n = g.node('a');
    expect(n).toBeDefined();
    expect('assignee' in (n as object)).toBe(false);
    expect('reflection' in (n as object)).toBe(false);
  });

  it('stores a reflection alongside a failure', () => {
    const g = chain();
    g.setStatus('wood', 'failed', 'no trees within 64 blocks');
    expect(g.node('wood')?.reflection).toBe('no trees within 64 blocks');
    expect(g.failed().map((n) => n.id)).toEqual(['wood']);
  });
});

describe('readyFrontier', () => {
  it('offers only nodes whose dependencies have all succeeded', () => {
    const g = chain();
    expect(g.readyFrontier().map((n) => n.id)).toEqual(['wood']);

    g.setStatus('wood', 'running');
    expect(g.readyFrontier()).toEqual([]);

    g.setStatus('wood', 'succeeded');
    expect(g.readyFrontier().map((n) => n.id)).toEqual(['planks']);
  });

  it('never offers a node behind a failure', () => {
    const g = chain();
    g.setStatus('wood', 'failed');
    expect(g.readyFrontier()).toEqual([]);
  });

  it('offers independent branches together', () => {
    const g = TaskGraph.from([
      { id: 'a', description: 'a' },
      { id: 'b', description: 'b' },
      { id: 'c', description: 'c', dependencies: ['a', 'b'] },
    ]);
    expect(g.readyFrontier().map((n) => n.id)).toEqual(['a', 'b']);
    g.setStatus('a', 'succeeded');
    expect(g.readyFrontier().map((n) => n.id)).toEqual(['b']);
    g.setStatus('b', 'succeeded');
    expect(g.readyFrontier().map((n) => n.id)).toEqual(['c']);
  });

  it('reports completion only when every node succeeded', () => {
    const g = chain();
    expect(g.isComplete()).toBe(false);
    for (const id of ['wood', 'planks', 'table']) g.setStatus(id, 'succeeded');
    expect(g.isComplete()).toBe(true);
    expect(g.readyFrontier()).toEqual([]);
    expect(new TaskGraph().isComplete()).toBe(true);
  });
});

describe('spliceInto', () => {
  it('rewires dependencies and dependents around the replaced node', () => {
    const g = chain();
    const sub = TaskGraph.from([
      { id: 'axe', description: 'craft axe' },
      { id: 'chop', description: 'chop tree', dependencies: ['axe'] },
    ]);
    g.spliceInto('planks', sub);

    expect(g.has('planks')).toBe(false);
    // Root of the subgraph inherits the replaced node's dependencies.
    expect(g.node('axe')?.dependencies).toEqual(['wood']);
    expect(g.node('chop')?.dependencies).toEqual(['axe']);
    // Dependents of the replaced node now depend on the subgraph's leaves.
    expect(g.node('table')?.dependencies).toEqual(['chop']);
    expect(g.hasCycle()).toBe(false);
  });

  it('carries the assignee down into an unassigned decomposition', () => {
    const g = TaskGraph.from([
      { id: 'root', description: 'build', assignee: 'bot-1' },
    ]);
    g.spliceInto(
      'root',
      TaskGraph.from([
        { id: 'x', description: 'x' },
        { id: 'y', description: 'y', assignee: 'bot-2' },
      ]),
    );
    expect(g.node('x')?.assignee).toBe('bot-1');
    expect(g.node('y')?.assignee).toBe('bot-2');
  });

  it('supports recursive decomposition of a spliced-in node', () => {
    const g = chain();
    g.spliceInto('planks', TaskGraph.from([{ id: 'p1', description: 'p1' }]));
    g.spliceInto(
      'p1',
      TaskGraph.from([
        { id: 'p1a', description: 'p1a' },
        { id: 'p1b', description: 'p1b', dependencies: ['p1a'] },
      ]),
    );
    expect(g.topologicalOrder()).toEqual(['wood', 'p1a', 'p1b', 'table']);
  });

  it('refuses an empty subgraph and colliding ids', () => {
    const g = chain();
    expect(() => g.spliceInto('planks', new TaskGraph())).toThrow(/empty/);
    expect(() =>
      g.spliceInto(
        'planks',
        TaskGraph.from([{ id: 'wood', description: 'x' }]),
      ),
    ).toThrow(/collides/);
    expect(g.size).toBe(3);
  });

  it('rolls back atomically when the result would be cyclic', () => {
    const g = chain();
    const before = g.toMermaid();
    // The decomposition of `planks` claims to depend on `table`, which already
    // depends on `planks`. This is the failure mode recursive decomposition
    // walks into whenever a model restates a downstream task.
    const sub = TaskGraph.from([
      { id: 'p1', description: 'p1', dependencies: ['table'] },
    ]);
    expect(() => g.spliceInto('planks', sub)).toThrow(CycleError);
    expect(g.has('planks')).toBe(true);
    expect(g.has('p1')).toBe(false);
    expect(g.toMermaid()).toBe(before);
    expect(g.hasCycle()).toBe(false);
  });
});

describe('cycle detection', () => {
  it('finds no cycle in a DAG including a diamond', () => {
    const g = TaskGraph.from([
      { id: 'a', description: 'a' },
      { id: 'b', description: 'b', dependencies: ['a'] },
      { id: 'c', description: 'c', dependencies: ['a'] },
      { id: 'd', description: 'd', dependencies: ['b', 'c'] },
    ]);
    expect(g.hasCycle()).toBe(false);
    expect(g.findCycle()).toBeUndefined();
    expect(g.topologicalOrder()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('finds a cycle introduced by a later edge', () => {
    const g = chain();
    expect(g.hasCycle()).toBe(false);
    g.addEdge('table', 'wood');
    expect(g.hasCycle()).toBe(true);
    const cycle = g.findCycle();
    expect(cycle).toBeDefined();
    const path = cycle as readonly string[];
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set(['wood', 'planks', 'table']));
  });

  it('finds a cycle that does not include the first node visited', () => {
    const g = TaskGraph.from([
      { id: 'start', description: 'start' },
      { id: 'a', description: 'a', dependencies: ['start'] },
      { id: 'b', description: 'b', dependencies: ['a'] },
      { id: 'c', description: 'c', dependencies: ['b'] },
    ]);
    g.addEdge('c', 'a');
    expect(g.hasCycle()).toBe(true);
    expect(new Set(g.findCycle())).toEqual(new Set(['a', 'b', 'c']));
  });

  it('throws from topologicalOrder on a cyclic graph', () => {
    const g = chain();
    g.addEdge('table', 'wood');
    expect(() => g.topologicalOrder()).toThrow(CycleError);
  });

  it('ignores dangling dependencies rather than inventing order', () => {
    const g = TaskGraph.from([
      { id: 'a', description: 'a', dependencies: ['ghost'] },
    ]);
    expect(g.hasCycle()).toBe(false);
    expect(g.topologicalOrder()).toEqual(['a']);
    expect(g.readyFrontier()).toEqual([]);
  });

  it('handles a deep chain without stack overflow', () => {
    const g = new TaskGraph();
    for (let i = 0; i < 20_000; i++) {
      g.addNode({
        id: `n${i}`,
        description: `n${i}`,
        dependencies: i === 0 ? [] : [`n${i - 1}`],
      });
    }
    expect(g.hasCycle()).toBe(false);
    expect(g.topologicalOrder()).toHaveLength(20_000);
  });
});

describe('topologicalOrder', () => {
  it('places every dependency before its dependent', () => {
    const g = TaskGraph.from([
      { id: 'd', description: 'd', dependencies: ['b', 'c'] },
      { id: 'c', description: 'c', dependencies: ['a'] },
      { id: 'b', description: 'b', dependencies: ['a'] },
      { id: 'a', description: 'a' },
    ]);
    const order = g.topologicalOrder();
    const at = (id: string): number => order.indexOf(id);
    for (const n of g.nodes()) {
      for (const dep of n.dependencies) expect(at(dep)).toBeLessThan(at(n.id));
    }
  });

  it('is deterministic across identical constructions', () => {
    expect(chain().topologicalOrder()).toEqual(chain().topologicalOrder());
  });
});

describe('toMermaid', () => {
  it('emits nodes with status classes and edges in dependency direction', () => {
    const g = chain();
    g.setStatus('wood', 'succeeded');
    const out = g.toMermaid();
    expect(out.startsWith('flowchart TD')).toBe(true);
    expect(out).toContain('wood["gather wood"]:::succeeded');
    expect(out).toContain('planks["craft planks"]:::pending');
    expect(out).toContain('wood --> planks');
    expect(out).toContain('planks --> table');
    expect(out).toContain('classDef failed');
  });

  it('shows the assignee and sanitises quotes and newlines', () => {
    const g = TaskGraph.from([
      { id: 'a', description: 'say "hi"\nthen wave', assignee: 'bot-1' },
    ]);
    const out = g.toMermaid();
    expect(out).toContain('a["say hi then wave @bot-1"]');
    expect(out.split('\n').filter((l) => l.includes('a['))).toHaveLength(1);
  });

  it('omits edges to nodes that are not present', () => {
    const g = TaskGraph.from([
      { id: 'a', description: 'a', dependencies: ['ghost'] },
    ]);
    expect(g.toMermaid()).not.toContain('ghost');
  });
});
