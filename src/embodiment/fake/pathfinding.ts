import type { Vec3Like } from '../geometry.js';
import { distance, floor, key } from '../geometry.js';
import type { FakeWorld } from './world.js';

/**
 * Ground-truth pathfinding over a {@link FakeWorld}.
 *
 * The fake body used to teleport, which made the offline suite blind to a whole
 * class of bug: a skill that assumes it can reach somewhere unreachable passed
 * every test and then failed the moment it met a real server. Since the fake
 * world carries most of this project's coverage, the fake must never be *more*
 * capable than a real body. So it walks, cell by cell, under rules a vanilla
 * player would recognise, and refuses when a real body would refuse.
 *
 * Everything here is deterministic, tie-breaking included: neighbours are
 * generated in a fixed order and the frontier breaks ties by insertion order,
 * so a failing test reproduces exactly.
 */

/** How the search is allowed to behave. All fields have defaults. */
export interface PathLimits {
  /**
   * How far the body may fall in one step before the route is refused. Vanilla
   * fall damage starts above three blocks, so three is where a careful body
   * stops.
   */
  readonly maxDrop: number;
  /**
   * Hard cap on expanded nodes. A search over an unbounded voxel world would
   * otherwise run until the heat death of the test suite; refusing loudly is
   * strictly better than hanging.
   */
  readonly maxNodes: number;
}

export const DEFAULT_LIMITS: PathLimits = Object.freeze({
  maxDrop: 3,
  maxNodes: 4_000,
});

/** Why a route could not be produced. */
export type PathFailure = 'no ground' | 'no route' | 'node limit';

export type PathResult =
  | {
      readonly ok: true;
      /**
       * Feet positions to walk through, in order, excluding the starting cell.
       * Each is the centre of a block column the body can stand in.
       */
      readonly steps: readonly Vec3Like[];
      /** How many nodes the search expanded, for cost assertions. */
      readonly expanded: number;
    }
  | {
      readonly ok: false;
      readonly failure: PathFailure;
      readonly detail: string;
      readonly expanded: number;
    };

/** Horizontal neighbours, in a fixed order so the search is reproducible. */
const HORIZONTAL: readonly Vec3Like[] = Object.freeze([
  Object.freeze({ x: 1, y: 0, z: 0 }),
  Object.freeze({ x: -1, y: 0, z: 0 }),
  Object.freeze({ x: 0, y: 0, z: 1 }),
  Object.freeze({ x: 0, y: 0, z: -1 }),
]);

/** Swimming adds the two vertical moves, again in a fixed order. */
const VERTICAL: readonly Vec3Like[] = Object.freeze([
  Object.freeze({ x: 0, y: 1, z: 0 }),
  Object.freeze({ x: 0, y: -1, z: 0 }),
]);

/**
 * Whether a cell is free for a body to occupy: loaded, and neither the feet
 * block nor the head block is solid.
 *
 * An unloaded cell is never free. That is the whole point of modelling it: a
 * real body cannot walk into a chunk the server has not sent, so the fake must
 * not either, however convenient that would be for a test.
 */
export function hasRoomToStand(world: FakeWorld, cell: Vec3Like): boolean {
  const feet = world.getBlock(cell);
  if (feet === undefined || feet.solid) return false;
  const head = world.getBlock({ x: cell.x, y: cell.y + 1, z: cell.z });
  if (head === undefined || head.solid) return false;
  return true;
}

/**
 * Whether a body can stand in a cell: room for feet and head, and solid ground
 * directly beneath. Ground that is unloaded is not ground.
 */
export function isStandable(world: FakeWorld, cell: Vec3Like): boolean {
  if (!hasRoomToStand(world, cell)) return false;
  const ground = world.getBlock({ x: cell.x, y: cell.y - 1, z: cell.z });
  return ground !== undefined && ground.solid;
}

/** The feet position a body occupies when standing in a cell. */
export function standingPosition(cell: Vec3Like): Vec3Like {
  return { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
}

interface Node {
  readonly cell: Vec3Like;
  readonly cost: number;
  readonly priority: number;
  /** Insertion order, the sole tie-breaker. Keeps the search reproducible. */
  readonly seq: number;
}

/**
 * Plan a walk from `start` to a goal near `target`.
 *
 * `range` is the arrival tolerance in blocks: any standable cell whose feet
 * position is within `range` of the target counts as arrival, which is what a
 * pathfinder goal does and what a caller asking for a range means.
 *
 * `swim` switches from walking to swimming: a body in a fluid is held up by it,
 * so it moves in all six directions and needs no ground. The fake tracks fluids
 * on the body rather than per cell, so this is decided once, from the body's own
 * proprioception, and holds for the whole route. It exists because refusing to
 * let a drowning body rise would be the fake being *less* capable than a real
 * one, which is the opposite of the bug being fixed here.
 */
export function planPath(
  world: FakeWorld,
  start: Vec3Like,
  target: Vec3Like,
  options: {
    readonly range?: number;
    readonly swim?: boolean;
    readonly limits?: PathLimits;
  } = {},
): PathResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const range = Math.max(0, options.range ?? 0);
  const swim = options.swim ?? false;
  const from = floor(start);
  const goalCell = floor(target);

  const occupiable = swim ? hasRoomToStand : isStandable;

  if (!occupiable(world, from)) {
    return {
      ok: false,
      failure: 'no ground',
      detail: swim
        ? `the body is not in open water at ${show(from)}`
        : `the body is not standing on solid ground at ${show(from)}`,
      expanded: 0,
    };
  }

  const reached = (cell: Vec3Like): boolean => {
    if (sameCell(cell, goalCell)) return true;
    if (range <= 0) return false;
    return distance(standingPosition(cell), target) <= range;
  };

  if (reached(from)) return { ok: true, steps: [], expanded: 0 };

  const cameFrom = new Map<string, Vec3Like | undefined>();
  const best = new Map<string, number>();
  const frontier = new MinHeap();
  let seq = 0;
  let expanded = 0;

  const startKey = key(from);
  cameFrom.set(startKey, undefined);
  best.set(startKey, 0);
  frontier.push({
    cell: from,
    cost: 0,
    priority: heuristic(from, goalCell),
    seq: seq++,
  });

  while (frontier.size > 0) {
    const node = frontier.pop();
    if (node === undefined) break;
    const nodeKey = key(node.cell);
    // A stale copy left behind by a cheaper re-entry; skip it.
    if ((best.get(nodeKey) ?? Number.POSITIVE_INFINITY) < node.cost) continue;

    if (reached(node.cell)) {
      return { ok: true, steps: rebuild(cameFrom, node.cell), expanded };
    }

    if (expanded >= limits.maxNodes) {
      return {
        ok: false,
        failure: 'node limit',
        detail: `gave up after exploring ${limits.maxNodes} cells towards ${show(goalCell)}`,
        expanded,
      };
    }
    expanded += 1;

    for (const move of neighbours(world, node.cell, swim, limits)) {
      const nextKey = key(move.cell);
      const cost = node.cost + move.cost;
      if (cost >= (best.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextKey, cost);
      cameFrom.set(nextKey, node.cell);
      frontier.push({
        cell: move.cell,
        cost,
        priority: cost + heuristic(move.cell, goalCell),
        seq: seq++,
      });
    }
  }

  return {
    ok: false,
    failure: 'no route',
    detail: `no walkable route to ${show(goalCell)}`,
    expanded,
  };
}

interface Move {
  readonly cell: Vec3Like;
  readonly cost: number;
}

/**
 * Every cell reachable in one move, in a fixed order.
 *
 * Walking: a level step, a step up of exactly one block (two is a wall, and no
 * candidate is ever generated for it), or a drop of up to `maxDrop`. A step up
 * also needs clearance two above the current feet, because the body jumps.
 */
function neighbours(
  world: FakeWorld,
  cell: Vec3Like,
  swim: boolean,
  limits: PathLimits,
): Move[] {
  const moves: Move[] = [];

  if (swim) {
    for (const d of [...HORIZONTAL, ...VERTICAL]) {
      const next = { x: cell.x + d.x, y: cell.y + d.y, z: cell.z + d.z };
      if (hasRoomToStand(world, next)) moves.push({ cell: next, cost: 1 });
    }
    return moves;
  }

  const headroomToJump = !isSolidKnown(world, {
    x: cell.x,
    y: cell.y + 2,
    z: cell.z,
  });

  for (const d of HORIZONTAL) {
    const level = { x: cell.x + d.x, y: cell.y, z: cell.z + d.z };
    if (isStandable(world, level)) {
      moves.push({ cell: level, cost: 1 });
      continue;
    }

    // Step up one. Anything higher is a wall the body cannot climb.
    const up = { x: level.x, y: level.y + 1, z: level.z };
    if (headroomToJump && isStandable(world, up)) {
      moves.push({ cell: up, cost: 1.5 });
      continue;
    }

    // Fall. Walk off the edge only if there is a floor within reach; the first
    // standable cell on the way down is where the body lands.
    if (!hasRoomToStand(world, level)) continue;
    for (let drop = 1; drop <= limits.maxDrop; drop += 1) {
      const below = { x: level.x, y: level.y - drop, z: level.z };
      if (isStandable(world, below)) {
        moves.push({ cell: below, cost: 1 + drop * 0.5 });
        break;
      }
      // Passing through requires the cell itself to be empty and loaded; an
      // unknown cell mid-fall stops the search rather than being guessed at.
      const feet = world.getBlock(below);
      if (feet === undefined || feet.solid) break;
    }
  }

  return moves;
}

/** Solid, or unknown. Used where unknown matter must count as an obstruction. */
function isSolidKnown(world: FakeWorld, cell: Vec3Like): boolean {
  const block = world.getBlock(cell);
  return block === undefined || block.solid;
}

/**
 * Admissible heuristic: every move changes x or z by exactly one and costs at
 * least one, so the horizontal Manhattan distance never overestimates.
 */
function heuristic(cell: Vec3Like, goal: Vec3Like): number {
  return Math.abs(cell.x - goal.x) + Math.abs(cell.z - goal.z);
}

function sameCell(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function rebuild(
  cameFrom: ReadonlyMap<string, Vec3Like | undefined>,
  end: Vec3Like,
): Vec3Like[] {
  const reversed: Vec3Like[] = [];
  let cursor: Vec3Like | undefined = end;
  while (cursor !== undefined) {
    reversed.push(cursor);
    cursor = cameFrom.get(key(cursor));
  }
  reversed.reverse();
  // Drop the starting cell: the body is already standing in it.
  return reversed.slice(1);
}

function show(cell: Vec3Like): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

/**
 * A binary heap keyed on priority, breaking ties by insertion order.
 *
 * An array-scan frontier would be simpler and quadratic; with a four thousand
 * node cap that is the difference between a suite that runs in two seconds and
 * one that does not.
 */
class MinHeap {
  readonly #items: Node[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(node: Node): void {
    this.#items.push(node);
    let i = this.#items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(this.#items[i], this.#items[parent])) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  pop(): Node | undefined {
    const items = this.#items;
    const top = items[0];
    if (top === undefined) return undefined;
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && before(items[left], items[smallest])) {
          smallest = left;
        }
        if (right < items.length && before(items[right], items[smallest])) {
          smallest = right;
        }
        if (smallest === i) break;
        this.#swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  #swap(a: number, b: number): void {
    const items = this.#items;
    const x = items[a];
    const y = items[b];
    if (x === undefined || y === undefined) return;
    items[a] = y;
    items[b] = x;
  }
}

function before(a: Node | undefined, b: Node | undefined): boolean {
  if (a === undefined) return false;
  if (b === undefined) return true;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}
