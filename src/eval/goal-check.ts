/**
 * Turning a task's goal into something that can actually be checked.
 *
 * The shipped suites state their goals as English sentences: `'inventory
 * contains at least 4 minecraft:stick'`, `'a minecraft:crafting_table block
 * exists within 4 blocks of the agent'`. Until this module existed nothing
 * parsed them, so no executor could tell whether a goal had been met. What
 * follows is a small declarative predicate language plus a strict parser for
 * exactly the sentence shapes the shipped suites use.
 *
 * Two rules govern everything here.
 *
 * 1. **The checker reads the world only through a `WorldView`.** This is
 *    deliberate and load-bearing. A checker that reached past the perception
 *    gate to privileged state would credit an agent for a fact it could not
 *    itself perceive, and the resulting score would measure the harness's
 *    eyesight rather than the agent's. Goal checking is therefore subject to
 *    the same perception budget, the same sight range and the same occlusion
 *    rules as the agent under test, and its reads are counted in the same
 *    ledger.
 *
 * 2. **An unparseable or uncheckable goal is never "not met".** It returns an
 *    explicit `checkable: false`, and callers are expected to turn that into an
 *    `error` outcome rather than a `failure`. A wiring bug that scored as agent
 *    failure would be the worst kind of bug a benchmark can have: silent, and
 *    biased in the direction that flatters the harness.
 */

import { distance } from '../embodiment/geometry.js';
import type { Vec3Like } from '../embodiment/geometry.js';
import type { WorldView } from '../perception/world-view.js';
import type { Task } from './task.js';

/* ------------------------------------------------------------------ */
/* Item names                                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip a `minecraft:` namespace.
 *
 * The suites write `minecraft:oak_log`. Everything below the gate writes
 * `oak_log`: `BlockInfo.name` is documented as namespace-free, and the symbolic
 * sandbox keys its inventory on bare names too. Left unnormalised, every single
 * goal check would compare `'minecraft:oak_log'` against `'oak_log'`, fail, and
 * look exactly like an agent that never picked anything up.
 */
export function normaliseItemName(name: string): string {
  const trimmed = name.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  const namespace = trimmed.slice(0, colon);
  // Only `minecraft` is stripped. A modded namespace is part of the identity of
  // the item and dropping it would merge two different things.
  return namespace === 'minecraft' ? trimmed.slice(colon + 1) : trimmed;
}

/**
 * Item tags used by the shipped suites, expanded to members.
 *
 * Hand-authored rather than read from `minecraft-data`, because a tag table
 * that changes when a dependency is bumped changes what a published score
 * meant. If this ever needs to grow beyond the suites' needs, it should become
 * versioned data next to the suites rather than a lookup at run time.
 */
export const ITEM_TAGS: Readonly<Record<string, readonly string[]>> = {
  logs: [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'stripped_oak_log',
    'stripped_birch_log',
    'stripped_spruce_log',
    'stripped_jungle_log',
    'stripped_acacia_log',
    'stripped_dark_oak_log',
    'stripped_mangrove_log',
    'stripped_cherry_log',
    'crimson_stem',
    'warped_stem',
  ],
  planks: [
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'bamboo_planks',
    'crimson_planks',
    'warped_planks',
  ],
};

/* ------------------------------------------------------------------ */
/* Predicates                                                          */
/* ------------------------------------------------------------------ */

/**
 * A goal reduced to something machine-checkable.
 *
 * Small on purpose. Every variant here is required by a shipped suite task; no
 * variant is here in anticipation of a task that does not exist.
 */
export type GoalPredicate =
  /** Holding at least `count` of one named item. */
  | { readonly kind: 'item-count'; readonly item: string; readonly count: number }
  /** Holding at least `count` items drawn from a tag. */
  | {
      readonly kind: 'item-tag-count';
      readonly tag: string;
      readonly items: readonly string[];
      readonly count: number;
    }
  /** A block of this name within `radius` blocks of the agent. */
  | {
      readonly kind: 'block-nearby';
      readonly block: string;
      readonly radius: number;
    }
  /** The agent standing at or above an altitude. */
  | { readonly kind: 'agent-y-at-least'; readonly y: number }
  /** The agent sealed in on all six sides. See the caveat in `checkPredicate`. */
  | { readonly kind: 'enclosed' };

export function describePredicate(predicate: GoalPredicate): string {
  switch (predicate.kind) {
    case 'item-count':
      return `hold at least ${predicate.count} ${predicate.item}`;
    case 'item-tag-count':
      return `hold at least ${predicate.count} items tagged ${predicate.tag}`;
    case 'block-nearby':
      return `a ${predicate.block} within ${predicate.radius} blocks`;
    case 'agent-y-at-least':
      return `stand at y >= ${predicate.y}`;
    case 'enclosed':
      return 'be enclosed on all six sides by solid blocks';
  }
}

/* ------------------------------------------------------------------ */
/* Parsing the shipped goal sentences                                  */
/* ------------------------------------------------------------------ */

export type GoalParse =
  | { readonly ok: true; readonly predicate: GoalPredicate }
  | { readonly ok: false; readonly reason: string };

/** `inventory contains at least 8 items tagged minecraft:logs` */
const TAGGED =
  /^inventory contains at least (\d+) items? tagged ([a-z0-9_:]+)\b/i;

/** `inventory contains at least 1 minecraft:wooden_pickaxe` */
const ITEM = /^inventory contains at least (\d+) ([a-z0-9_:]+)\b/i;

/** `a minecraft:crafting_table block exists within 4 blocks of the agent` */
const BLOCK_NEARBY =
  /^an? ([a-z0-9_:]+) block exists within (\d+) blocks? of the agent\b/i;

/** `agent y position is at least 5000 (beyond the build limit)` */
const ALTITUDE = /^agent y position is at least (-?\d+)\b/i;

/** `agent position is fully enclosed by solid blocks and sky access is 0` */
const ENCLOSED = /^agent position is fully enclosed by solid blocks\b/i;

function count(raw: string | undefined, what: string): number | string {
  if (raw === undefined) return `missing ${what}`;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return `${what} must be positive, got ${raw}`;
  return n;
}

/**
 * Parse one of the goal sentences the shipped suites use.
 *
 * Strict by design: anything not matching a known shape is rejected with a
 * reason rather than guessed at. English is a poor place to keep a predicate,
 * and this parser is a bridge, not an endorsement. The right long-term fix is a
 * structured field on `Task`; see the note in this module's tests and the
 * project report.
 */
export function parseGoal(goal: string): GoalParse {
  const text = goal.trim();

  const tagged = TAGGED.exec(text);
  if (tagged) {
    const n = count(tagged[1], 'goal count');
    if (typeof n === 'string') return { ok: false, reason: n };
    const tag = normaliseItemName(tagged[2] ?? '');
    const items = ITEM_TAGS[tag];
    if (items === undefined) {
      return {
        ok: false,
        reason: `unknown item tag "${tag}"; add it to ITEM_TAGS to check this goal`,
      };
    }
    return { ok: true, predicate: { kind: 'item-tag-count', tag, items, count: n } };
  }

  const item = ITEM.exec(text);
  if (item) {
    const n = count(item[1], 'goal count');
    if (typeof n === 'string') return { ok: false, reason: n };
    return {
      ok: true,
      predicate: {
        kind: 'item-count',
        item: normaliseItemName(item[2] ?? ''),
        count: n,
      },
    };
  }

  const block = BLOCK_NEARBY.exec(text);
  if (block) {
    const radius = count(block[2], 'radius');
    if (typeof radius === 'string') return { ok: false, reason: radius };
    return {
      ok: true,
      predicate: {
        kind: 'block-nearby',
        block: normaliseItemName(block[1] ?? ''),
        radius,
      },
    };
  }

  const altitude = ALTITUDE.exec(text);
  if (altitude) {
    const y = Number.parseInt(altitude[1] ?? '', 10);
    if (!Number.isFinite(y)) return { ok: false, reason: 'unreadable altitude' };
    return { ok: true, predicate: { kind: 'agent-y-at-least', y } };
  }

  if (ENCLOSED.test(text)) return { ok: true, predicate: { kind: 'enclosed' } };

  return {
    ok: false,
    reason: `no goal predicate matches "${goal}"`,
  };
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

export type GoalCheck =
  | {
      readonly checkable: true;
      readonly met: boolean;
      readonly detail: string;
      /** Set when the check held, but not over the whole of what was asked. */
      readonly caveat?: string;
    }
  | { readonly checkable: false; readonly reason: string };

function totalHeld(
  stacks: readonly { readonly name: string; readonly count: number }[],
  wanted: ReadonlySet<string>,
): number {
  let held = 0;
  for (const stack of stacks) {
    if (wanted.has(normaliseItemName(stack.name))) held += stack.count;
  }
  return held;
}

/** The six face neighbours of a block position. */
const FACES: readonly Vec3Like[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/**
 * Evaluate a predicate against a live world.
 *
 * Every read goes through `world`, which is the gated, counted surface the
 * agent itself uses. Nothing in here touches a bot handle or a sensor port, and
 * nothing should ever be added that does.
 */
export function checkPredicate(
  predicate: GoalPredicate,
  world: WorldView,
): GoalCheck {
  switch (predicate.kind) {
    case 'item-count': {
      const held = totalHeld(world.inventory().value, new Set([predicate.item]));
      return {
        checkable: true,
        met: held >= predicate.count,
        detail: `holding ${held} ${predicate.item}, needed ${predicate.count}`,
      };
    }
    case 'item-tag-count': {
      const wanted = new Set(predicate.items.map(normaliseItemName));
      const held = totalHeld(world.inventory().value, wanted);
      return {
        checkable: true,
        met: held >= predicate.count,
        detail: `holding ${held} items tagged ${predicate.tag}, needed ${predicate.count}`,
      };
    }
    case 'block-nearby': {
      const origin = world.body().value.position;
      const found = world.findBlocks({
        names: [predicate.block],
        maxDistance: predicate.radius,
      });
      // `findBlocks` is bounded by the profile's sight range as well as by the
      // radius asked for, and may answer from memory. Both are correct here: a
      // block the agent cannot perceive is a block it should not be credited
      // for having placed.
      const near = found.filter(
        (b) => distance(b.value.position, origin) <= predicate.radius,
      );
      const first = near[0];
      return {
        checkable: true,
        met: first !== undefined,
        detail:
          first === undefined
            ? `no ${predicate.block} within ${predicate.radius} blocks`
            : `${predicate.block} at ${format(first.value.position)} (${first.provenance})`,
      };
    }
    case 'agent-y-at-least': {
      const body = world.body().value;
      return {
        checkable: true,
        met: body.position.y >= predicate.y,
        detail: `agent y is ${body.position.y}, needed ${predicate.y}`,
      };
    }
    case 'enclosed': {
      const body = world.body().value;
      const origin = {
        x: Math.floor(body.position.x),
        y: Math.floor(body.position.y),
        z: Math.floor(body.position.z),
      };
      const open: string[] = [];
      for (const face of FACES) {
        const at = {
          x: origin.x + face.x,
          y: origin.y + face.y,
          z: origin.z + face.z,
        };
        const block = world.blockAt(at);
        // `undefined` means not known, which is not the same as not there. An
        // unknown neighbour cannot be counted as a wall.
        if (block === undefined || !block.value.solid) open.push(format(at));
      }
      return {
        checkable: true,
        met: open.length === 0,
        detail:
          open.length === 0
            ? 'all six faces are solid'
            : `open faces: ${open.join(', ')}`,
        // The suite's sentence also asks for sky access of 0. `WorldView`
        // exposes no sky-light query, and inventing one would mean reading
        // privileged state. The six-face check is stated as the weaker thing it
        // is rather than dressed up as the stronger thing that was asked for.
        caveat:
          'sky access is not derivable from WorldView; only the six face neighbours were checked',
      };
    }
  }
}

function format(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

/**
 * Check a predicate against a plain item-count map.
 *
 * For tiers with no `WorldView` at all, notably the symbolic sandbox. Only the
 * two inventory predicates can be answered this way; the rest report
 * `checkable: false` so that a caller reports an uncheckable task honestly
 * rather than scoring it as a failure.
 */
export function checkPredicateAgainstItems(
  predicate: GoalPredicate,
  counts: Readonly<Record<string, number>>,
): GoalCheck {
  const held = (wanted: ReadonlySet<string>): number => {
    let n = 0;
    for (const [name, c] of Object.entries(counts)) {
      if (wanted.has(normaliseItemName(name))) n += c;
    }
    return n;
  };
  switch (predicate.kind) {
    case 'item-count': {
      const n = held(new Set([predicate.item]));
      return {
        checkable: true,
        met: n >= predicate.count,
        detail: `holding ${n} ${predicate.item}, needed ${predicate.count}`,
      };
    }
    case 'item-tag-count': {
      const n = held(new Set(predicate.items.map(normaliseItemName)));
      return {
        checkable: true,
        met: n >= predicate.count,
        detail: `holding ${n} items tagged ${predicate.tag}, needed ${predicate.count}`,
      };
    }
    default:
      return {
        checkable: false,
        reason: `predicate "${describePredicate(predicate)}" needs a positional world; an inventory alone cannot answer it`,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Task-level entry points                                             */
/* ------------------------------------------------------------------ */

/**
 * Predicates supplied by the caller, keyed by task id.
 *
 * An escape hatch for a task whose goal sentence this module cannot parse, and
 * the mechanism a suite author should use rather than bending a goal sentence
 * to fit the regexes above.
 */
export type GoalPredicateOverrides = Readonly<Record<string, GoalPredicate>>;

export function predicateFor(
  task: Task,
  overrides?: GoalPredicateOverrides,
): GoalParse {
  // Order matters. A caller-supplied override wins, because it is the most
  // specific statement of intent. An authored predicate on the task comes
  // next. Parsing the prose is the fallback, since a reworded sentence must
  // not be able to change what a suite measures.
  const override = overrides?.[task.id];
  if (override !== undefined) return { ok: true, predicate: override };
  if (task.goalPredicate !== undefined) {
    return { ok: true, predicate: task.goalPredicate };
  }
  return parseGoal(task.goal);
}

/** Parse and check a task's goal against a live world in one call. */
export function checkTaskGoal(
  task: Task,
  world: WorldView,
  overrides?: GoalPredicateOverrides,
): GoalCheck {
  const parsed = predicateFor(task, overrides);
  if (!parsed.ok) {
    return {
      checkable: false,
      reason: `task ${task.id}: ${parsed.reason}`,
    };
  }
  return checkPredicate(parsed.predicate, world);
}
