import { Inventory } from './inventory.js';
import type { ItemCounts } from './inventory.js';
import { RecipeBook } from './recipes.js';
import type { CraftingRecipe } from './recipes.js';
import {
  DEFAULT_AGENT_POSITION,
  DEFAULT_BUILD_LIMIT,
  DEFAULT_PLACE_REACH,
  DEFAULT_WORLD_FLOOR,
  FACE_OFFSETS,
  addVec,
  chebyshevDistance,
  distanceBetween,
  formatPosition,
  isBlockPosition,
  positionKey,
  sameVec,
} from './space.js';
import type { PlacedBlock, Vec3 } from './space.js';

/**
 * A symbolic Minecraft world: an inventory, a finite pile of nearby resources,
 * a biome label, whether a crafting table and furnace are in reach, and a
 * sparse map of block coordinates.
 *
 * What survives is the part a planner can be wrong about: whether the materials
 * exist, whether the station is available, whether the recipe is real, and now
 * whether the agent has actually put something where it said it would.
 *
 * The spatial half is deliberately thin, and `space.ts` documents at length
 * what it does not represent: no terrain, no gravity, no collision volume, no
 * light, no time. Read that comment before trusting a positional score.
 * A world constructed without any spatial setup behaves exactly as it did
 * before the model existed: the agent stands at a default position, nothing is
 * placed anywhere, and no non-spatial action consults a coordinate.
 *
 * Every refusal is a discriminated value carrying the reason. A boolean `false`
 * would tell an agent that something went wrong and nothing about what to do
 * next, which is the failure mode the rest of this project is built to avoid.
 */

export type ActionKind = 'mine' | 'craft' | 'smelt' | 'place' | 'move';

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
  | 'invalid-count'
  /** Placing needs the block in the inventory and it is not there. */
  | 'item-not-held'
  /** A coordinate with a non-integer or non-finite component. */
  | 'invalid-position'
  /** Something is already at that coordinate, or the agent is standing there. */
  | 'position-occupied'
  /** Further than the agent can place, or further than one step to move. */
  | 'out-of-reach'
  /** Below the world floor or above the build limit. */
  | 'outside-world-height';

export interface ActionSuccess {
  readonly ok: true;
  readonly action: ActionKind;
  /**
   * The item the action was about. For `place` this is the block put down; for
   * `move` there is no item, so it names the thing that changed instead.
   */
  readonly item: string;
  /** How many were actually added to the inventory. Zero for `place`. */
  readonly gained: number;
  /** What was consumed, empty for `mine` and `move`. */
  readonly consumed: ItemCounts;
  readonly inventory: Inventory;
  /** Where the block went, or where the agent ended up. Spatial actions only. */
  readonly position?: Vec3;
}

export interface ActionRefusal {
  readonly ok: false;
  readonly action: ActionKind;
  readonly item: string;
  readonly reason: RefusalReason;
  readonly message: string;
  /**
   * Present for `missing-ingredient`, `resource-exhausted` and
   * `item-not-held`.
   */
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
  /** Where the agent starts. Defaults to `DEFAULT_AGENT_POSITION`. */
  readonly agent?: Vec3;
  /** Blocks already in the world. Later entries win on a repeated coordinate. */
  readonly blocks?: readonly PlacedBlock[];
  /** Lowest buildable y, inclusive. */
  readonly worldFloor?: number;
  /** Highest buildable y, inclusive. */
  readonly buildLimit?: number;
  /** How far the agent can place a block, in blocks. */
  readonly placeReach?: number;
}

/**
 * The `item` a `move` result carries.
 *
 * `ActionResult` has always named an item, and a move is about no item at all.
 * Naming the agent is less misleading than borrowing an item name it did not
 * touch.
 */
const AGENT = 'agent';

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
  /** Lowest buildable y, inclusive. */
  readonly worldFloor: number;
  /** Highest buildable y, inclusive. */
  readonly buildLimit: number;
  /** How far the agent can place a block, in blocks. */
  readonly placeReach: number;

  #inventory: Inventory;
  #resources: Map<string, number>;
  #craftingTable: boolean;
  #furnace: boolean;
  #agent: Vec3;
  /** Coordinate key to block. A missing key is air; there is no terrain. */
  #blocks: Map<string, PlacedBlock>;

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
    this.worldFloor = spec.worldFloor ?? DEFAULT_WORLD_FLOOR;
    this.buildLimit = spec.buildLimit ?? DEFAULT_BUILD_LIMIT;
    this.placeReach = spec.placeReach ?? DEFAULT_PLACE_REACH;

    const start = spec.agent ?? DEFAULT_AGENT_POSITION;
    if (!isBlockPosition(start)) {
      throw new RangeError(
        `agent position must have integer components, got ${formatPosition(start)}`,
      );
    }
    this.#agent = { x: start.x, y: start.y, z: start.z };
    this.#blocks = new Map();
    for (const block of spec.blocks ?? []) {
      if (!isBlockPosition(block.position)) {
        throw new RangeError(
          `block position must have integer components, got ${formatPosition(block.position)}`,
        );
      }
      const position: Vec3 = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      };
      this.#blocks.set(positionKey(position), { position, name: block.name });
    }
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
   * Bring a crafting table or furnace into reach without placing one.
   *
   * Predates the spatial model and is kept: a task that wants to start with a
   * station available, or an agent that crafts one and is credited with using
   * it, should not have to nominate a coordinate. `place` sets the same flag
   * when the block put down is a station, so both routes agree.
   */
  bringIntoReach(station: 'crafting_table' | 'furnace'): void {
    if (station === 'crafting_table') this.#craftingTable = true;
    else this.#furnace = true;
  }

  /* ---------------------------------------------------------------- */
  /* Space                                                             */
  /* ---------------------------------------------------------------- */

  /** Where the agent is standing, as a block coordinate. */
  get agentPosition(): Vec3 {
    return this.#agent;
  }

  /** The block at a coordinate, or `undefined` for air. */
  blockAt(position: Vec3): PlacedBlock | undefined {
    return this.#blocks.get(positionKey(position));
  }

  /** Every placed block, ordered by coordinate so snapshots are stable. */
  blocks(): readonly PlacedBlock[] {
    return [...this.#blocks.values()].sort((a, b) =>
      positionKey(a.position) < positionKey(b.position) ? -1 : 1,
    );
  }

  /**
   * Placed blocks of a name within `radius` blocks of the agent, nearest first.
   *
   * Straight-line distance, matching the live tier's check, so a goal scored in
   * both tiers means the same thing.
   */
  blocksWithin(name: string, radius: number): readonly PlacedBlock[] {
    return this.blocks()
      .filter(
        (b) =>
          b.name === name &&
          distanceBetween(b.position, this.#agent) <= radius,
      )
      .sort(
        (a, b) =>
          distanceBetween(a.position, this.#agent) -
          distanceBetween(b.position, this.#agent),
      );
  }

  /**
   * The face neighbours of the agent's cell that are not solid.
   *
   * The agent is one cell with no height, so this is six lookups. A real player
   * is two blocks tall and a real enclosure check is harder than this one.
   */
  openFaces(): readonly Vec3[] {
    return FACE_OFFSETS.map((offset) => addVec(this.#agent, offset)).filter(
      (at) => this.#blocks.get(positionKey(at)) === undefined,
    );
  }

  /** True when all six faces of the agent's cell hold a block. */
  get enclosed(): boolean {
    return this.openFaces().length === 0;
  }

  /**
   * Put a held block down at a coordinate.
   *
   * Consumes one of the block from the inventory. Nothing checks that the
   * position is supported or reachable by a path: reach is a straight-line
   * radius and that is the whole rule.
   */
  place(block: string, at: Vec3): ActionResult {
    if (!isBlockPosition(at)) {
      return refuse(
        'place',
        block,
        'invalid-position',
        `block positions are integers, got ${formatPosition(at)}`,
      );
    }
    if (at.y < this.worldFloor || at.y > this.buildLimit) {
      return refuse(
        'place',
        block,
        'outside-world-height',
        `y ${at.y} is outside the buildable range ${this.worldFloor}..${this.buildLimit}`,
      );
    }
    const reach = distanceBetween(at, this.#agent);
    if (reach > this.placeReach) {
      return refuse(
        'place',
        block,
        'out-of-reach',
        `${formatPosition(at)} is ${reach.toFixed(2)} blocks away, reach is ${this.placeReach}`,
      );
    }
    if (sameVec(at, this.#agent)) {
      return refuse(
        'place',
        block,
        'position-occupied',
        `the agent is standing at ${formatPosition(at)}`,
      );
    }
    const existing = this.blockAt(at);
    if (existing) {
      return refuse(
        'place',
        block,
        'position-occupied',
        `${existing.name} is already at ${formatPosition(at)}`,
      );
    }
    const held = this.#inventory.count(block);
    if (held < 1) {
      return refuse(
        'place',
        block,
        'item-not-held',
        `placing ${block} needs one in the inventory, which holds none`,
        { item: block, needed: 1, held },
      );
    }

    const position: Vec3 = { x: at.x, y: at.y, z: at.z };
    this.#blocks.set(positionKey(position), { position, name: block });
    this.#inventory = this.#inventory.remove(block, 1);
    // A station the agent just put down within reach is a station in reach.
    if (block === 'crafting_table' || block === 'furnace') {
      this.bringIntoReach(block);
    }
    return {
      ok: true,
      action: 'place',
      item: block,
      gained: 0,
      consumed: { [block]: 1 },
      inventory: this.#inventory,
      position,
    };
  }

  /**
   * Step the agent to an adjacent cell.
   *
   * One cell at a time, diagonals included, and only into air. There is no
   * gravity and no support rule, so a step upward into empty space is allowed;
   * the build limit is what stops an agent walking to an arbitrary altitude.
   */
  move(to: Vec3): ActionResult {
    if (!isBlockPosition(to)) {
      return refuse(
        'move',
        AGENT,
        'invalid-position',
        `block positions are integers, got ${formatPosition(to)}`,
      );
    }
    if (to.y < this.worldFloor || to.y > this.buildLimit) {
      return refuse(
        'move',
        AGENT,
        'outside-world-height',
        `y ${to.y} is outside the world's range ${this.worldFloor}..${this.buildLimit}`,
      );
    }
    const step = chebyshevDistance(to, this.#agent);
    if (step > 1) {
      return refuse(
        'move',
        AGENT,
        'out-of-reach',
        `${formatPosition(to)} is ${step} cells from ${formatPosition(this.#agent)}; a move is one step`,
      );
    }
    const blocking = this.blockAt(to);
    if (blocking) {
      return refuse(
        'move',
        AGENT,
        'position-occupied',
        `${blocking.name} occupies ${formatPosition(to)}`,
      );
    }

    this.#agent = { x: to.x, y: to.y, z: to.z };
    return {
      ok: true,
      action: 'move',
      item: AGENT,
      gained: 0,
      consumed: {},
      inventory: this.#inventory,
      position: this.#agent,
    };
  }

  clone(): SymbolicWorld {
    const copy = new SymbolicWorld({
      inventory: this.#inventory,
      resources: this.resources(),
      biome: this.biome,
      craftingTable: this.#craftingTable,
      furnace: this.#furnace,
      recipes: this.recipes,
      agent: this.#agent,
      blocks: this.blocks(),
      worldFloor: this.worldFloor,
      buildLimit: this.buildLimit,
      placeReach: this.placeReach,
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
