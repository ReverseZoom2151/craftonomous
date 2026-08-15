import { Inventory } from './inventory.js';
import { RecipeBook } from './recipes.js';
import type { CraftingRecipe, Ingredient } from './recipes.js';

/**
 * Dependency reasoning over the recipe graph.
 *
 * The graph is genuinely cyclic. Nine iron ingots make an iron block and an
 * iron block makes nine ingots back; nine nuggets make an ingot and an ingot
 * makes nine nuggets. A planner that walks this data without an explicit guard
 * does not merely give a wrong answer, it fails to give one at all, so the
 * guard is a feature of the model rather than defensive coding: every recursion
 * here carries an `inProgress` set, a depth cap, and a global node budget.
 *
 * Failure is data. When a target cannot be reached, the plan comes back with
 * the raw materials that must be gathered rather than an exception, because
 * "you need four more oak logs" is the answer an agent can act on and
 * "unsatisfiable" is not.
 */

export interface CraftStep {
  readonly kind: 'craft';
  readonly item: string;
  /** Number of times the recipe is applied. */
  readonly times: number;
  /** `times * recipe.resultCount`. */
  readonly produces: number;
  readonly consumes: readonly Ingredient[];
  readonly recipe: CraftingRecipe;
  readonly requiresCraftingTable: boolean;
}

export interface SmeltStep {
  readonly kind: 'smelt';
  readonly item: string;
  readonly times: number;
  readonly produces: number;
  readonly input: string;
  readonly consumes: readonly Ingredient[];
}

export type PlanStep = CraftStep | SmeltStep;

/** A raw material that must be gathered because nothing produces it. */
export type MissingMaterial = Ingredient;

export interface PlanSuccess {
  readonly ok: true;
  readonly target: string;
  readonly count: number;
  /** In execution order: every step's inputs exist once its predecessors ran. */
  readonly steps: readonly PlanStep[];
  /** True when at least one step needs a crafting table. */
  readonly requiresCraftingTable: boolean;
  /** True when at least one step is a smelt. */
  readonly requiresFurnace: boolean;
  /** What the inventory holds once the plan has run, target included. */
  readonly resulting: Inventory;
}

export type PlanFailure =
  | {
      readonly ok: false;
      readonly reason: 'missing-materials';
      readonly target: string;
      readonly count: number;
      /** What must be gathered first; nothing in the recipe graph makes these. */
      readonly missing: readonly MissingMaterial[];
      /** The plan that would work once `missing` is in hand. */
      readonly steps: readonly PlanStep[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown-item';
      readonly target: string;
      readonly count: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'search-exhausted';
      readonly target: string;
      readonly count: number;
      /** How many search nodes were spent before giving up. */
      readonly nodes: number;
    };

export type PlanResult = PlanSuccess | PlanFailure;

export interface PlanOptions {
  /**
   * Items that can be gathered rather than made. Shortfalls in this set are
   * preferred over any other, which is how the planner learns that this world
   * has raw iron lying about but no iron ore, without being told the geometry.
   */
  readonly gatherable?: Iterable<string>;
  /** Hard cap on recursion depth. Defaults to 32. */
  readonly maxDepth?: number;
  /** Hard cap on search nodes. Defaults to 20000. */
  readonly maxNodes?: number;
}

export interface DependencyOptions {
  /**
   * `preferred` follows only each item's default recipe, which is what a
   * planner will actually do. `all` unions every alternative, which is what you
   * want when asking "could this item ever depend on that one".
   */
  readonly mode?: 'preferred' | 'all';
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 20_000;

class SearchExhausted extends Error {
  constructor(readonly nodes: number) {
    super(`recipe search exceeded its node budget (${nodes})`);
    this.name = 'SearchExhausted';
  }
}

interface Work {
  readonly have: Inventory;
  readonly steps: readonly PlanStep[];
  /** Items nothing can produce, accumulated as the search discovers them. */
  readonly missing: ReadonlyMap<string, number>;
}

interface Ctx {
  readonly book: RecipeBook;
  readonly gatherable: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxNodes: number;
  nodes: number;
}

/**
 * Reporting a shortfall of something the recipe graph can itself produce is a
 * dead end dressed up as an answer: "you are missing an iron block" is not what
 * an agent holding raw iron needs to hear. Such a shortfall is priced far above
 * any quantity of genuinely raw material, so a route that ends in gatherable
 * things always wins over one that ends in a craftable thing.
 */
const PRODUCIBLE_PENALTY = 1_000_000;

/** Units of a declared-gatherable shortfall are cheaper than any other. */
function unitPrice(item: string, ctx: Ctx): number {
  return ctx.gatherable.has(item) ? 1 : 2;
}

function producibleCost(item: string, ctx: Ctx): number {
  if (ctx.gatherable.has(item)) return 0;
  return ctx.book.isCraftable(item) ? PRODUCIBLE_PENALTY : 0;
}

function priceShortfall(item: string, units: number, ctx: Ctx): number {
  return units * unitPrice(item, ctx) + producibleCost(item, ctx);
}

/** What a candidate route adds to the shortfall, priced as above. */
function shortfallCost(trial: Work, base: Work, ctx: Ctx): number {
  let cost = 0;
  for (const [item, n] of trial.missing) {
    const delta = n - (base.missing.get(item) ?? 0);
    if (delta <= 0) continue;
    cost += priceShortfall(item, delta, ctx);
  }
  return cost;
}

function addMissing(work: Work, item: string, count: number): Work {
  const next = new Map(work.missing);
  next.set(item, (next.get(item) ?? 0) + count);
  return { ...work, missing: next };
}

export class TechTree {
  readonly book: RecipeBook;

  constructor(book: RecipeBook = RecipeBook.forVersion()) {
    this.book = book;
  }

  /**
   * Every item transitively needed to produce `item`, excluding `item` itself.
   *
   * Terminates on cyclic data: an item already on the walk is not re-expanded.
   */
  dependencies(
    item: string,
    options: DependencyOptions = {},
  ): readonly string[] {
    const mode = options.mode ?? 'preferred';
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const seen = new Set<string>();
    const out = new Set<string>();

    const walk = (current: string, depth: number): void => {
      if (depth > maxDepth) return;
      if (seen.has(current)) return;
      seen.add(current);

      const recipes =
        mode === 'all'
          ? this.book.craftingRecipes(current)
          : this.book.craftingRecipes(current).slice(0, 1);
      for (const recipe of recipes) {
        for (const ingredient of recipe.ingredients) {
          out.add(ingredient.item);
          walk(ingredient.item, depth + 1);
        }
      }

      const smelt = this.book.smeltingRecipe(current);
      if (smelt) {
        const inputs = mode === 'all' ? smelt.inputs : smelt.inputs.slice(0, 1);
        for (const input of inputs) {
          out.add(input);
          walk(input, depth + 1);
        }
      }
    };

    walk(item, 0);
    out.delete(item);
    return [...out].sort();
  }

  /** True when `item` appears in its own dependency closure. */
  isCyclic(item: string): boolean {
    return this.dependenciesIncludeSelf(item);
  }

  private dependenciesIncludeSelf(item: string): boolean {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const recipe of this.book.craftingRecipes(item)) {
      stack.push(...recipe.ingredients.map((i) => i.item));
    }
    const smelt = this.book.smeltingRecipe(item);
    if (smelt) stack.push(...smelt.inputs);

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === item) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const recipe of this.book.craftingRecipes(current)) {
        stack.push(...recipe.ingredients.map((i) => i.item));
      }
      const s = this.book.smeltingRecipe(current);
      if (s) stack.push(...s.inputs);
    }
    return false;
  }

  /**
   * An ordered craft/smelt plan reaching `count` of `target` from `have`.
   *
   * Steps come back in execution order. When the inventory and the recipe graph
   * cannot close the gap, the result names the raw materials to gather and
   * still returns the plan that those materials would unlock.
   */
  craftingPlan(
    target: string,
    count: number,
    have: Inventory = Inventory.empty(),
    options: PlanOptions = {},
  ): PlanResult {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }
    if (!this.book.knowsItem(target)) {
      return { ok: false, reason: 'unknown-item', target, count };
    }

    const ctx: Ctx = {
      book: this.book,
      gatherable: new Set(options.gatherable ?? []),
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
      nodes: 0,
    };

    let work: Work;
    try {
      work = acquire(
        target,
        count,
        { have: have.clone(), steps: [], missing: new Map() },
        new Set(),
        0,
        ctx,
      );
    } catch (err) {
      if (err instanceof SearchExhausted) {
        return {
          ok: false,
          reason: 'search-exhausted',
          target,
          count,
          nodes: err.nodes,
        };
      }
      throw err;
    }

    const steps = mergeAdjacent(work.steps);

    if (work.missing.size > 0) {
      const missing = [...work.missing.entries()]
        .map(([item, n]) => ({ item, count: n }))
        .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
      return {
        ok: false,
        reason: 'missing-materials',
        target,
        count,
        missing,
        steps,
      };
    }

    return {
      ok: true,
      target,
      count,
      steps,
      requiresCraftingTable: steps.some(
        (s) => s.kind === 'craft' && s.requiresCraftingTable,
      ),
      requiresFurnace: steps.some((s) => s.kind === 'smelt'),
      resulting: work.have.add(target, count),
    };
  }
}

/**
 * Ensure `need` of `item` exists, consuming it from the working inventory.
 *
 * Anything that cannot be produced is recorded in `missing` and then treated as
 * if it had been gathered, so the search keeps going and reports every gap at
 * once rather than one per run.
 */
function acquire(
  item: string,
  need: number,
  work: Work,
  inProgress: ReadonlySet<string>,
  depth: number,
  ctx: Ctx,
): Work {
  ctx.nodes += 1;
  if (ctx.nodes > ctx.maxNodes) throw new SearchExhausted(ctx.nodes);

  const onHand = Math.min(work.have.count(item), need);
  const current: Work =
    onHand > 0 ? { ...work, have: work.have.remove(item, onHand) } : work;
  const remaining = need - onHand;
  if (remaining === 0) return current;

  // A self-referential expansion cannot make progress; charge it as raw.
  if (inProgress.has(item) || depth >= ctx.maxDepth) {
    return addMissing(current, item, remaining);
  }

  const nested = new Set(inProgress);
  nested.add(item);

  const baselineCost = priceShortfall(item, remaining, ctx);
  let best: { work: Work; cost: number; steps: number } | undefined;

  for (const candidate of candidatesFor(item, ctx)) {
    const trial = tryCandidate(
      candidate,
      remaining,
      current,
      nested,
      depth,
      ctx,
    );
    if (!trial) continue;
    // A route whose shortfall re-names the item it was meant to produce has
    // made no progress. This is what stops ingot -> block -> ingot.
    if ((trial.missing.get(item) ?? 0) > (current.missing.get(item) ?? 0)) {
      continue;
    }
    const cost = shortfallCost(trial, current, ctx);
    if (cost === 0) return trial;
    const steps = trial.steps.length;
    if (
      !best ||
      cost < best.cost ||
      (cost === best.cost && steps < best.steps)
    ) {
      best = { work: trial, cost, steps };
    }
  }

  if (best && best.cost <= baselineCost) return best.work;
  return addMissing(current, item, remaining);
}

type Candidate =
  | { readonly kind: 'craft'; readonly recipe: CraftingRecipe }
  | {
      readonly kind: 'smelt';
      readonly result: string;
      readonly input: string;
      readonly resultCount: number;
    };

function candidatesFor(item: string, ctx: Ctx): readonly Candidate[] {
  const out: Candidate[] = ctx.book
    .craftingRecipes(item)
    .map((recipe) => ({ kind: 'craft', recipe }) as const);
  const smelt = ctx.book.smeltingRecipe(item);
  if (smelt) {
    for (const input of smelt.inputs) {
      out.push({
        kind: 'smelt',
        result: smelt.result,
        input,
        resultCount: smelt.resultCount,
      });
    }
  }
  return out;
}

function tryCandidate(
  candidate: Candidate,
  need: number,
  work: Work,
  inProgress: ReadonlySet<string>,
  depth: number,
  ctx: Ctx,
): Work | undefined {
  const resultCount =
    candidate.kind === 'craft'
      ? candidate.recipe.resultCount
      : candidate.resultCount;
  const times = Math.ceil(need / resultCount);
  const produces = times * resultCount;

  const consumes: Ingredient[] =
    candidate.kind === 'craft'
      ? candidate.recipe.ingredients.map((i) => ({
          item: i.item,
          count: i.count * times,
        }))
      : [{ item: candidate.input, count: times }];

  let current = work;
  for (const ingredient of consumes) {
    current = acquire(
      ingredient.item,
      ingredient.count,
      current,
      inProgress,
      depth + 1,
      ctx,
    );
  }

  const step: PlanStep =
    candidate.kind === 'craft'
      ? {
          kind: 'craft',
          item: candidate.recipe.result,
          times,
          produces,
          consumes,
          recipe: candidate.recipe,
          requiresCraftingTable: candidate.recipe.requiresCraftingTable,
        }
      : {
          kind: 'smelt',
          item: candidate.result,
          times,
          produces,
          input: candidate.input,
          consumes,
        };

  // The surplus from rounding up to whole crafts stays available downstream.
  const surplus = produces - need;
  const have =
    surplus > 0 ? current.have.add(step.item, surplus) : current.have;

  return { ...current, have, steps: [...current.steps, step] };
}

function mergeAdjacent(steps: readonly PlanStep[]): readonly PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (last && sameOperation(last, step)) {
      out[out.length - 1] = mergeSteps(last, step);
    } else {
      out.push(step);
    }
  }
  return out;
}

function sameOperation(a: PlanStep, b: PlanStep): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'craft' && b.kind === 'craft') return a.recipe === b.recipe;
  if (a.kind === 'smelt' && b.kind === 'smelt') {
    return a.item === b.item && a.input === b.input;
  }
  return false;
}

function mergeSteps(a: PlanStep, b: PlanStep): PlanStep {
  const times = a.times + b.times;
  const produces = a.produces + b.produces;
  const consumes = mergeIngredients(a.consumes, b.consumes);
  if (a.kind === 'craft' && b.kind === 'craft') {
    return { ...a, times, produces, consumes };
  }
  return { ...(a as SmeltStep), times, produces, consumes };
}

function mergeIngredients(
  a: readonly Ingredient[],
  b: readonly Ingredient[],
): readonly Ingredient[] {
  const counts = new Map<string, number>();
  for (const i of [...a, ...b]) {
    counts.set(i.item, (counts.get(i.item) ?? 0) + i.count);
  }
  return [...counts.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((x, y) => (x.item < y.item ? -1 : x.item > y.item ? 1 : 0));
}
