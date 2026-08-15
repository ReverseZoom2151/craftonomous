/**
 * A task DAG with recursive decomposition.
 *
 * The survey's strongest scheduling design is VillagerAgent's dependency graph:
 * work is a graph rather than a list, a node may be replaced in place by a
 * subgraph that accomplishes it, and only the frontier of dependency-satisfied
 * nodes is ever offered for execution. The idea is reimplemented here from that
 * description; no code was consulted.
 *
 * Two properties matter more than they look:
 *
 * - **Splicing is where cycles come from.** Replacing a node with a subgraph
 *   rewires every edge that touched it. A subgraph that references an existing
 *   node, or a decomposition that restates its own parent, produces a graph that
 *   can never make progress. `spliceInto` therefore validates and rolls back.
 * - **The frontier is a query, not a queue.** Nothing is scheduled in advance,
 *   so a status change anywhere is immediately reflected in what is runnable.
 */

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TaskNode {
  readonly id: string;
  readonly description: string;
  readonly status: TaskStatus;
  /** Ids that must reach `succeeded` before this node may run. */
  readonly dependencies: readonly string[];
  /** Who is meant to do this. Free-form: an agent name, a role, a bot id. */
  readonly assignee?: string;
  /**
   * Post-mortem note attached after a failure. Kept on the node rather than in
   * a side channel so that a replan sees why the last attempt did not work.
   */
  readonly reflection?: string;
}

/** What a caller supplies to create a node. */
export interface TaskSpec {
  readonly id: string;
  readonly description: string;
  readonly dependencies?: readonly string[];
  readonly assignee?: string;
  readonly status?: TaskStatus;
  readonly reflection?: string;
}

/** Thrown when an operation would leave the graph unable to make progress. */
export class CycleError extends Error {
  constructor(
    message: string,
    readonly cycle: readonly string[],
  ) {
    super(message);
    this.name = 'CycleError';
  }
}

interface MutableNode {
  id: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  assignee?: string;
  reflection?: string;
}

function freeze(n: MutableNode): TaskNode {
  const base = {
    id: n.id,
    description: n.description,
    status: n.status,
    dependencies: [...n.dependencies],
  };
  // exactOptionalPropertyTypes: an absent field and a field set to undefined
  // are different types, so build the object rather than assigning undefined.
  if (n.assignee !== undefined && n.reflection !== undefined) {
    return { ...base, assignee: n.assignee, reflection: n.reflection };
  }
  if (n.assignee !== undefined) return { ...base, assignee: n.assignee };
  if (n.reflection !== undefined) return { ...base, reflection: n.reflection };
  return base;
}

function clone(n: MutableNode): MutableNode {
  const c: MutableNode = {
    id: n.id,
    description: n.description,
    status: n.status,
    dependencies: [...n.dependencies],
  };
  if (n.assignee !== undefined) c.assignee = n.assignee;
  if (n.reflection !== undefined) c.reflection = n.reflection;
  return c;
}

export class TaskGraph {
  readonly #nodes = new Map<string, MutableNode>();

  /** Build a graph from specs, in order. Dependencies may name later nodes. */
  static from(specs: Iterable<TaskSpec>): TaskGraph {
    const g = new TaskGraph();
    for (const s of specs) g.addNode(s);
    return g;
  }

  get size(): number {
    return this.#nodes.size;
  }

  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  addNode(spec: TaskSpec): void {
    if (this.#nodes.has(spec.id)) {
      throw new Error(`duplicate task id: ${spec.id}`);
    }
    const n: MutableNode = {
      id: spec.id,
      description: spec.description,
      status: spec.status ?? 'pending',
      dependencies: [...(spec.dependencies ?? [])],
    };
    if (spec.assignee !== undefined) n.assignee = spec.assignee;
    if (spec.reflection !== undefined) n.reflection = spec.reflection;
    this.#nodes.set(spec.id, n);
  }

  /**
   * `from` must succeed before `to` may run.
   *
   * Deliberately does not reject cycles: a caller building a graph incrementally
   * may pass through invalid intermediate states. Validity is a question you ask
   * (`hasCycle`), not an invariant enforced edge by edge. `spliceInto` is the
   * exception, because a decomposition is meant to be atomic.
   */
  addEdge(from: string, to: string): void {
    const dependent = this.#require(to);
    this.#require(from);
    if (from === to) {
      throw new CycleError(`task ${from} cannot depend on itself`, [
        from,
        from,
      ]);
    }
    if (!dependent.dependencies.includes(from)) {
      dependent.dependencies.push(from);
    }
  }

  node(id: string): TaskNode | undefined {
    const n = this.#nodes.get(id);
    return n ? freeze(n) : undefined;
  }

  nodes(): readonly TaskNode[] {
    return [...this.#nodes.values()].map(freeze);
  }

  setStatus(id: string, status: TaskStatus, reflection?: string): void {
    const n = this.#require(id);
    n.status = status;
    if (reflection !== undefined) n.reflection = reflection;
  }

  /** Attach a post-failure note without changing status. */
  reflect(id: string, reflection: string): void {
    this.#require(id).reflection = reflection;
  }

  /**
   * Nodes that are pending and whose every dependency has succeeded.
   *
   * `running` nodes are excluded so the frontier can be polled repeatedly
   * without handing the same task out twice. A node depending on a failed node
   * never enters the frontier, which is what stops a doomed branch from
   * consuming attempts.
   */
  readyFrontier(): readonly TaskNode[] {
    const out: TaskNode[] = [];
    for (const n of this.#nodes.values()) {
      if (n.status !== 'pending') continue;
      const ready = n.dependencies.every(
        (d) => this.#nodes.get(d)?.status === 'succeeded',
      );
      if (ready) out.push(freeze(n));
    }
    return out;
  }

  /** True when every node has succeeded. An empty graph is complete. */
  isComplete(): boolean {
    for (const n of this.#nodes.values()) {
      if (n.status !== 'succeeded') return false;
    }
    return true;
  }

  /** Any node that failed and has not been replaced by a decomposition. */
  failed(): readonly TaskNode[] {
    return this.nodes().filter((n) => n.status === 'failed');
  }

  /**
   * Replace `nodeId` with `subgraph`, rewiring edges.
   *
   * The subgraph's roots (nodes with no dependency inside the subgraph) inherit
   * the replaced node's dependencies; the subgraph's leaves (nodes nothing
   * inside the subgraph depends on) become dependencies of everything that
   * depended on the replaced node. The replaced node is removed.
   *
   * Atomic: if the result would contain a cycle, or the subgraph collides with
   * existing ids, nothing is changed and the call throws.
   */
  spliceInto(nodeId: string, subgraph: TaskGraph): void {
    const target = this.#require(nodeId);
    if (subgraph.size === 0) {
      throw new Error(`cannot splice an empty subgraph into ${nodeId}`);
    }
    for (const sub of subgraph.#nodes.keys()) {
      if (sub !== nodeId && this.#nodes.has(sub)) {
        throw new Error(`splice into ${nodeId} collides with task id: ${sub}`);
      }
    }

    const snapshot = this.#snapshot();
    try {
      const subIds = new Set(subgraph.#nodes.keys());
      const roots: string[] = [];
      const hasDependent = new Set<string>();
      for (const s of subgraph.#nodes.values()) {
        const inner = s.dependencies.filter((d) => subIds.has(d));
        if (inner.length === 0) roots.push(s.id);
        for (const d of inner) hasDependent.add(d);
      }
      const leaves = [...subIds].filter((id) => !hasDependent.has(id));

      const dependents = [...this.#nodes.values()].filter(
        (n) => n.id !== nodeId && n.dependencies.includes(nodeId),
      );
      const inheritedDeps = target.dependencies.filter((d) => !subIds.has(d));

      this.#nodes.delete(nodeId);
      for (const s of subgraph.#nodes.values()) {
        const copy = clone(s);
        copy.dependencies = [
          ...new Set([
            // Keep internal edges, and external edges that name a node this
            // graph actually has: a decomposition is allowed to depend on work
            // that already exists elsewhere in the plan.
            ...copy.dependencies.filter(
              (d) => subIds.has(d) || (d !== nodeId && this.#nodes.has(d)),
            ),
            ...(roots.includes(copy.id) ? inheritedDeps : []),
          ]),
        ];
        if (copy.assignee === undefined && target.assignee !== undefined) {
          copy.assignee = target.assignee;
        }
        this.#nodes.set(copy.id, copy);
      }
      for (const d of dependents) {
        d.dependencies = [
          ...new Set([
            ...d.dependencies.filter((x) => x !== nodeId),
            ...leaves,
          ]),
        ];
      }

      const cycle = this.#findCycle();
      if (cycle) {
        throw new CycleError(
          `splicing into ${nodeId} would create a cycle: ${cycle.join(' -> ')}`,
          cycle,
        );
      }
    } catch (err) {
      this.#restore(snapshot);
      throw err;
    }
  }

  hasCycle(): boolean {
    return this.#findCycle() !== undefined;
  }

  /** The cycle found, as a path whose first and last element are equal. */
  findCycle(): readonly string[] | undefined {
    return this.#findCycle();
  }

  /**
   * Dependencies before dependents. Ties broken by insertion order, so the
   * output is deterministic and diffable across runs.
   */
  topologicalOrder(): readonly string[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const n of this.#nodes.values()) {
      indegree.set(n.id, 0);
      dependents.set(n.id, []);
    }
    for (const n of this.#nodes.values()) {
      for (const d of n.dependencies) {
        if (!this.#nodes.has(d)) continue; // dangling dep: not an ordering fact
        indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
        dependents.get(d)?.push(n.id);
      }
    }
    const queue = [...this.#nodes.keys()].filter(
      (id) => (indegree.get(id) ?? 0) === 0,
    );
    const out: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      out.push(id);
      for (const dep of dependents.get(id) ?? []) {
        const left = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, left);
        if (left === 0) queue.push(dep);
      }
    }
    if (out.length !== this.#nodes.size) {
      const cycle = this.#findCycle() ?? [];
      throw new CycleError(`graph is cyclic: ${cycle.join(' -> ')}`, cycle);
    }
    return out;
  }

  /**
   * Mermaid `flowchart TD`, for eyeballing a plan in a log or a review.
   * Status is carried in the node class, so a stuck branch is visible.
   */
  toMermaid(): string {
    const lines: string[] = ['flowchart TD'];
    for (const n of this.#nodes.values()) {
      const label = n.description
        .replace(/["\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const suffix = n.assignee !== undefined ? ` @${n.assignee}` : '';
      lines.push(`  ${n.id}["${label}${suffix}"]:::${n.status}`);
    }
    for (const n of this.#nodes.values()) {
      for (const d of n.dependencies) {
        if (this.#nodes.has(d)) lines.push(`  ${d} --> ${n.id}`);
      }
    }
    lines.push('  classDef pending fill:#eee,stroke:#999;');
    lines.push('  classDef running fill:#cfe,stroke:#39c;');
    lines.push('  classDef succeeded fill:#cfc,stroke:#3a3;');
    lines.push('  classDef failed fill:#fcc,stroke:#c33;');
    return lines.join('\n');
  }

  #require(id: string): MutableNode {
    const n = this.#nodes.get(id);
    if (!n) throw new Error(`unknown task id: ${id}`);
    return n;
  }

  #snapshot(): MutableNode[] {
    return [...this.#nodes.values()].map(clone);
  }

  #restore(snapshot: readonly MutableNode[]): void {
    this.#nodes.clear();
    for (const n of snapshot) this.#nodes.set(n.id, clone(n));
  }

  /** Iterative DFS with a colouring, so deep graphs cannot blow the stack. */
  #findCycle(): string[] | undefined {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const colour = new Map<string, number>();
    for (const id of this.#nodes.keys()) colour.set(id, WHITE);

    for (const start of this.#nodes.keys()) {
      if (colour.get(start) !== WHITE) continue;
      const path: string[] = [];
      const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
      colour.set(start, GREY);
      path.push(start);
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as { id: string; next: number };
        const deps = this.#nodes.get(top.id)?.dependencies ?? [];
        if (top.next >= deps.length) {
          colour.set(top.id, BLACK);
          stack.pop();
          path.pop();
          continue;
        }
        const dep = deps[top.next] as string;
        top.next += 1;
        if (!this.#nodes.has(dep)) continue;
        const c = colour.get(dep);
        if (c === GREY) {
          const at = path.indexOf(dep);
          return [...path.slice(at), dep];
        }
        if (c === WHITE) {
          colour.set(dep, GREY);
          path.push(dep);
          stack.push({ id: dep, next: 0 });
        }
      }
    }
    return undefined;
  }
}
