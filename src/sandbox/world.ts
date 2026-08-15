import { Inventory } from './inventory.js';
import type { ItemCounts } from './inventory.js';
import { RecipeBook } from './recipes.js';
import type { CraftingRecipe } from './recipes.js';

/**
 * A symbolic Minecraft world: an inventory, a finite pile of nearby resources,
 * a biome label, and whether a crafting table and furnace are in reach.
 *
 * There is no geometry, no time, and no mobs. What survives is the part a
 * planner can be wrong about: whether the materials exist, whether the station
 * is available, and whether the recipe is real.
 *
 * Every refusal is a discriminated value carrying the reason. A boolean `false`
 * would tell an agent that something went wrong and nothing about what to do
 * next, which is the failure mode the rest of this project is built to avoid.
 */

export type ActionKind = 'mine' | 'craft' | 'smelt';

export type RefusalReason =
  /** No recipe at this version produces the requested item. */
  | 'unknown-recipe'
  /** Nothing nearby yields this resource. */
  | 'unknown-resource'
  /** The nearby deposit is depleted. */
  | 'resource-exhausted'
  /** An input is not in the inventory. */
  | 'missing-ingredient'
  /** The recipe needs a 3x3 grid and no table is in reach. */
  | 'no-crafting-table'
  /** Smelting needs a furnace and none is in reach. */
  | 'no-furnace'
  /** Non-positive or non-integer count. */
  | 'invalid-count';

export interface ActionSuccess {
  readonly ok: true;
  readonly action: ActionKind;
  readonly item: string;
  /** How many were actually added to the inventory. */
  readonly gained: number;
  /** What was consumed, empty for `mine`. */
  readonly consumed: ItemCounts;
  readonly inventory: Inventory;
}

export interface ActionRefusal {
  readonly ok: false;
  readonly action: ActionKind;
  readonly item: string;
  readonly reason: RefusalReason;
  readonly message: string;
  /** Present for `missing-ingredient` and `resource-exhausted`. */
  readonly shortfall?: {
    readonly item: string;
    readonly needed: number;
    readonly held: number;
  };
}

export type ActionResult = ActionSuccess | ActionRefusal;

export interface SymbolicWorldSpec {
  readonly inventory?: ItemCounts | Inventory;
  /** Nearby deposits and how many units each still holds. */
  readonly resources?: ItemCounts;
  readonly biome?: string;
  readonly craftingTable?: boolean;
  readonly furnace?: boolean;
  readonly recipes?: RecipeBook;
}

function refuse(
  action: ActionKind,
  item: string,
  reason: RefusalReason,
  message: string,
  shortfall?: { item: string; needed: number; held: number },
): ActionRefusal {
  return shortfall
    ? { ok: false, action, item, reason, message, shortfall }
    : { ok: false, action, item, reason, message };
}

export class SymbolicWorld {
  readonly biome: string;
  readonly recipes: RecipeBook;

  #inventory: Inventory;
  #resources: Map<string, number>;
  #craftingTable: boolean;
  #furnace: boolean;

  constructor(spec: SymbolicWorldSpec = {}) {
    const inv = spec.inventory;
    this.#inventory =
      inv instanceof Inventory ? inv.clone() : Inventory.from(inv ?? {});
    this.#resources = new Map(
      Object.entries(spec.resources ?? {}).filter(([, n]) => n > 0),
    );
    this.biome = spec.biome ?? 'plains';
    this.#craftingTable = spec.craftingTable ?? false;
    this.#furnace = spec.furnace ?? false;
    this.recipes = spec.recipes ?? RecipeBook.forVersion();
  }

  get inventory(): Inventory {
    return this.#inventory;
  }

  get craftingTableInReach(): boolean {
    return this.#craftingTable;
  }

  get furnaceInReach(): boolean {
    return this.#furnace;
  }

  /** Remaining quantity of a nearby deposit. */
  resourceCount(resource: string): number {
    return this.#resources.get(resource) ?? 0;
  }

  /** All nearby deposits with their remaining quantities. */
  resources(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.#resources.keys()].sort()) {
      out[key] = this.#resources.get(key)!;
    }
    return out;
  }

  /**
   * Bring a crafting table or furnace into reach.
   *
   * Placement is not modelled as an action — the sandbox has no positions — but
   * a task that starts without a table and crafts one needs some way to say so.
   */
  bringIntoReach(station: 'crafting_table' | 'furnace'): void {
    if (station === 'crafting_table') this.#craftingTable = true;
    else this.#furnace = true;
  }

  clone(): SymbolicWorld {
    const copy = new SymbolicWorld({
      inventory: this.#inventory,
      resources: this.resources(),
      biome: this.biome,
      craftingTable: this.#craftingTable,
      furnace: this.#furnace,
      recipes: this.recipes,
    });
    return copy;
  }

  /** Take `count` units from a nearby deposit. */
  mine(resource: string, count = 1): ActionResult {
    if (!Number.isInteger(count) || count <= 0) {
      return refuse(
        'mine',
        resource,
        'invalid-count',
        `count must be a positive integer, got ${count}`,
      );
    }
    if (!this.#resources.has(resource)) {
      return refuse(
        'mine',
        resource,
        'unknown-resource',
        `no ${resource} is nearby in the ${this.biome} biome`,
      );
    }
    const available = this.resourceCount(resource);
    if (available < count) {
      return refuse(
        'mine',
        resource,
        'resource-exhausted',
        `only ${available} ${resource} remain nearby, asked for ${count}`,
        { item: resource, needed: count, held: available },
      );
    }
    const left = available - count;
    if (left === 0) this.#resources.delete(resource);
    else this.#resources.set(resource, left);
    this.#inventory = this.#inventory.add(resource, count);
    return {
      ok: true,
      action: 'mine',
      item: resource,
      gained: count,
      consumed: {},
      inventory: this.#inventory,
    };
  }

  /**
   * Apply a crafting recipe enough times to make at least `count`.
   *
   * The surplus from rounding up to whole crafts is kept, exactly as the game
   * does: asking for one stick leaves you holding four.
   */
  craft(item: string, count = 1): ActionResult {
    if (!Number.isInteger(count) || count <= 0) {
      return refuse(
        'craft',
        item,
        'invalid-count',
        `count must be a positive integer, got ${count}`,
      );
    }
    const recipes = this.recipes.craftingRecipes(item);
    if (recipes.length === 0) {
      return refuse(
        'craft',
        item,
        'unknown-recipe',
        `nothing at Minecraft ${this.recipes.version} crafts ${item}`,
      );
    }

    // Prefer a recipe we can actually run: the right variant depends on which
    // wood or stone is in the inventory, not on which one sorts first.
    let tableBlocked: CraftingRecipe | undefined;
    let bestShortfall:
      | { recipe: CraftingRecipe; item: string; needed: number; held: number }
      | undefined;

    for (const recipe of recipes) {
      const batches = Math.ceil(count / recipe.resultCount);
      if (recipe.requiresCraftingTable && !this.#craftingTable) {
        tableBlocked ??= recipe;
        continue;
      }
      const short = recipe.ingredients
        .map((i) => ({
          item: i.item,
          needed: i.count * batches,
          held: this.#inventory.count(i.item),
        }))
        .find((i) => i.held < i.needed);
      if (short) {
        bestShortfall ??= { recipe, ...short };
        continue;
      }
      let next = this.#inventory;
      for (const ingredient of recipe.ingredients) {
        next = next.remove(ingredient.item, ingredient.count * batches);
      }
      const produced = batches * recipe.resultCount;
      this.#inventory = next.add(item, produced);
      const consumed: Record<string, number> = {};
      for (const ingredient of recipe.ingredients) {
        consumed[ingredient.item] = ingredient.count * batches;
      }
      return {
        ok: true,
        action: 'craft',
        item,
        gained: produced,
        consumed,
        inventory: this.#inventory,
      };
    }

    if (bestShortfall) {
      return refuse(
        'craft',
        item,
        'missing-ingredient',
        `crafting ${count} ${item} needs ${bestShortfall.needed} ${bestShortfall.item}, inventory holds ${bestShortfall.held}`,
        {
          item: bestShortfall.item,
          needed: bestShortfall.needed,
          held: bestShortfall.held,
        },
      );
    }
    return refuse(
      'craft',
      item,
      'no-crafting-table',
      `${item} needs a 3x3 grid and no crafting table is in reach`,
    );
  }

  /** Smelt `count` of `item` from any accepted input that is in the inventory. */
  smelt(item: string, count = 1): ActionResult {
    if (!Number.isInteger(count) || count <= 0) {
      return refuse(
        'smelt',
        item,
        'invalid-count',
        `count must be a positive integer, got ${count}`,
      );
    }
    const recipe = this.recipes.smeltingRecipe(item);
    if (!recipe) {
      return refuse(
        'smelt',
        item,
        'unknown-recipe',
        `no known furnace recipe produces ${item}`,
      );
    }
    if (!this.#furnace) {
      return refuse(
        'smelt',
        item,
        'no-furnace',
        `smelting ${item} needs a furnace in reach`,
      );
    }
    const batches = Math.ceil(count / recipe.resultCount);
    const usable = recipe.inputs.find((i) => this.#inventory.has(i, batches));
    if (!usable) {
      const first = recipe.inputs[0]!;
      return refuse(
        'smelt',
        item,
        'missing-ingredient',
        `smelting ${count} ${item} needs ${batches} of one of: ${recipe.inputs.join(', ')}`,
        { item: first, needed: batches, held: this.#inventory.count(first) },
      );
    }
    this.#inventory = this.#inventory
      .remove(usable, batches)
      .add(item, batches * recipe.resultCount);
    return {
      ok: true,
      action: 'smelt',
      item,
      gained: batches * recipe.resultCount,
      consumed: { [usable]: batches },
      inventory: this.#inventory,
    };
  }
}
