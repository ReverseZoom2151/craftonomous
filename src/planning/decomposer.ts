/**
 * Bounded incremental decomposition.
 *
 * The technique worth taking from VillagerAgent is not "ask a model to break
 * the goal down" — everyone does that — it is *refusing to plan the whole tree
 * up front*. At most `lookahead` nodes are expanded per round, so the planning
 * context stays bounded no matter how large the goal is, and the plan below the
 * frontier stays unwritten until the world has had a chance to contradict it.
 *
 * The expander is injected. In production it is an LLM call; in tests it is a
 * lookup table. Nothing in this file knows which.
 */

import { TaskGraph } from './dag.js';
import type { TaskSpec } from './dag.js';

export interface ExpandContext {
  /** 0 for the root goal, 1 for its children, and so on. */
  readonly depth: number;
  /** Id of the node being expanded. */
  readonly nodeId: string;
  /** Goals already present in the plan, normalised. Lets an expander avoid
   *  restating work; the decomposer drops repeats regardless. */
  readonly known: readonly string[];
}

/**
 * Break a goal into subgoals. Returning an empty array means "this is
 * primitive, do not decompose it further" — that is the expander's only way to
 * say stop, and it is honoured.
 */
export type Expander = (
  goal: string,
  context: ExpandContext,
) => Promise<readonly string[]>;

export interface DecomposeOptions {
  /** Maximum nodes expanded per round. The bound that matters. Default 5. */
  readonly lookahead?: number;
  /** Hard cap on tree depth. Default 4. */
  readonly maxDepth?: number;
  /** Hard cap on total nodes. Default 64. */
  readonly maxNodes?: number;
  /** Hard cap on rounds, so a pathological expander still terminates. Default 16. */
  readonly maxRounds?: number;
  /**
   * How subgoals of one parent relate. `sequential` chains them (each depends
   * on the previous), which is the conservative reading of an ordered list from
   * a model; `parallel` leaves them independent. Default `sequential`.
   */
  readonly subtaskOrder?: 'sequential' | 'parallel';
  /** Assignee stamped on generated nodes. */
  readonly assignee?: string;
}

export type StopReason = 'exhausted' | 'max-rounds' | 'max-nodes' | 'max-depth';

export interface DecomposeResult {
  readonly graph: TaskGraph;
  /** Rounds actually run. */
  readonly rounds: number;
  /** Expander calls made. Never exceeds rounds * lookahead. */
  readonly expansions: number;
  /**
   * Leaves left unexpanded when the run stopped. Non-empty means the plan is
   * deliberately partial and should be resumed after acting, which is the whole
   * point of a bounded lookahead.
   */
  readonly pending: readonly string[];
  /** Subgoals dropped because an equivalent node was already in the plan. */
  readonly repeatsDropped: number;
  readonly stoppedBecause: StopReason;
}

const DEFAULTS = {
  lookahead: 5,
  maxDepth: 4,
  maxNodes: 64,
  maxRounds: 16,
  subtaskOrder: 'sequential' as const,
};

/** Case- and whitespace-insensitive identity for a goal. */
export function normaliseGoal(goal: string): string {
  return goal
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
}

function slug(goal: string, seq: number): string {
  const base = normaliseGoal(goal)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return `t${seq}_${base.length > 0 ? base : 'task'}`;
}

interface Frontier {
  readonly id: string;
  readonly goal: string;
  readonly depth: number;
}

/**
 * Expand `goal` into a task graph, a bounded number of nodes at a time.
 *
 * Termination is guaranteed by four independent guards — depth, node count,
 * round count, and repeat detection — because each alone is easy to defeat: a
 * model that answers "mine iron" with ["mine iron"] defeats depth accounting
 * only if repeats are ignored, and a model that fans out defeats repeat
 * detection only if node count is unbounded.
 */
export async function decompose(
  goal: string,
  expand: Expander,
  options: DecomposeOptions = {},
): Promise<DecomposeResult> {
  const lookahead = options.lookahead ?? DEFAULTS.lookahead;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;
  const maxRounds = options.maxRounds ?? DEFAULTS.maxRounds;
  const order = options.subtaskOrder ?? DEFAULTS.subtaskOrder;
  if (lookahead < 1) throw new RangeError(`lookahead must be >= 1`);
  if (maxDepth < 0) throw new RangeError(`maxDepth must be >= 0`);

  const graph = new TaskGraph();
  let seq = 0;
  const rootId = slug(goal, seq++);
  const rootSpec: TaskSpec =
    options.assignee !== undefined
      ? { id: rootId, description: goal, assignee: options.assignee }
      : { id: rootId, description: goal };
  graph.addNode(rootSpec);

  const seen = new Map<string, string>([[normaliseGoal(goal), rootId]]);
  let queue: Frontier[] = [{ id: rootId, goal, depth: 0 }];

  let rounds = 0;
  let expansions = 0;
  let repeatsDropped = 0;
  let stoppedBecause: StopReason = 'exhausted';
  let hitDepth = false;
  let hitNodes = false;

  while (queue.length > 0) {
    if (rounds >= maxRounds) {
      stoppedBecause = 'max-rounds';
      break;
    }
    if (graph.size >= maxNodes) {
      stoppedBecause = 'max-nodes';
      hitNodes = true;
      break;
    }

    // The bound. Everything past `lookahead` waits for a later round, which in
    // a live agent means: after the earlier tasks have actually been attempted.
    const round = queue.slice(0, lookahead);
    const rest = queue.slice(lookahead);
    rounds += 1;

    const expandable = round.filter((f) => f.depth < maxDepth);
    if (expandable.length < round.length) hitDepth = true;

    const known = [...seen.keys()];
    const results = await Promise.all(
      expandable.map(async (f) => ({
        frontier: f,
        subgoals: await expand(f.goal, {
          depth: f.depth,
          nodeId: f.id,
          known,
        }),
      })),
    );
    expansions += results.length;

    const next: Frontier[] = [];
    for (const { frontier, subgoals } of results) {
      const fresh: { goal: string; key: string }[] = [];
      for (const raw of subgoals) {
        const text = raw.trim();
        if (text.length === 0) continue;
        const key = normaliseGoal(text);
        // A subgoal that restates its parent, or restates a node already in the
        // plan, is not progress. Dropping it is what makes a self-referential
        // expander terminate rather than recurse to the depth cap.
        if (seen.has(key) || fresh.some((f) => f.key === key)) {
          repeatsDropped += 1;
          continue;
        }
        fresh.push({ goal: text, key });
      }

      if (fresh.length === 0) continue; // primitive, or wholly redundant

      if (graph.size + fresh.length > maxNodes) {
        hitNodes = true;
        continue; // leave this node pending rather than truncate its children
      }

      const sub = new TaskGraph();
      const ids: string[] = [];
      for (const [i, item] of fresh.entries()) {
        const id = slug(item.goal, seq++);
        const deps =
          order === 'sequential' && i > 0 ? [ids[i - 1] as string] : [];
        const spec: TaskSpec =
          options.assignee !== undefined
            ? {
                id,
                description: item.goal,
                dependencies: deps,
                assignee: options.assignee,
              }
            : { id, description: item.goal, dependencies: deps };
        sub.addNode(spec);
        ids.push(id);
      }

      graph.spliceInto(frontier.id, sub);
      seen.delete(normaliseGoal(frontier.goal));
      for (const [i, item] of fresh.entries()) {
        const id = ids[i] as string;
        seen.set(item.key, id);
        next.push({ id, goal: item.goal, depth: frontier.depth + 1 });
      }
    }

    // Nodes at the depth cap, and nodes whose expansion returned nothing, stay
    // in the plan as unexpanded leaves. They are executable work, not errors,
    // so they leave the expansion queue rather than blocking it.
    queue = [...rest, ...next];
  }

  if (stoppedBecause === 'exhausted') {
    if (hitNodes) stoppedBecause = 'max-nodes';
    else if (hitDepth) stoppedBecause = 'max-depth';
  }

  return {
    graph,
    rounds,
    expansions,
    pending: queue.map((f) => f.id).filter((id) => graph.has(id)),
    repeatsDropped,
    stoppedBecause,
  };
}
