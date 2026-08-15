import minecraftData from 'minecraft-data';

/**
 * Crafting and smelting rules, derived from `minecraft-data` at a pinned
 * version.
 *
 * Crafting recipes are derived, not hand-written. `minecraft-data` ships the
 * full shaped/shapeless recipe set keyed by numeric item id; we normalise it to
 * item names and ingredient multisets, which is all a symbolic planner needs.
 *
 * Smelting is *not* in `minecraft-data` — the package carries `recipes.json`
 * (crafting only), with no furnace, blasting, smoking or campfire data. The
 * smelting table below is therefore hand-authored and deliberately small; see
 * `SMELTING` for exactly what it covers. Every entry is validated against the
 * item registry at construction, and anything the pinned version does not
 * recognise is reported through `droppedSmeltingEntries` rather than silently
 * ignored.
 */

/** The Minecraft version the recipe data is read from. */
export const DEFAULT_MINECRAFT_VERSION = '1.21.1';

export interface Ingredient {
  readonly item: string;
  readonly count: number;
}

export interface CraftingRecipe {
  readonly result: string;
  /** How many are produced per craft. */
  readonly resultCount: number;
  /** Ingredients per craft, aggregated by item and sorted by item name. */
  readonly ingredients: readonly Ingredient[];
  readonly shape: 'shaped' | 'shapeless';
  /**
   * True when the recipe does not fit the 2x2 inventory grid.
   *
   * Derived from the grid footprint for shaped recipes and from the ingredient
   * count for shapeless ones, which is exactly the vanilla rule.
   */
  readonly requiresCraftingTable: boolean;
}

export interface SmeltingRecipe {
  readonly result: string;
  /** How many are produced per smelt. Always 1 in vanilla. */
  readonly resultCount: number;
  /** Accepted inputs, most canonical first. One input yields one result. */
  readonly inputs: readonly string[];
}

/**
 * Hand-authored furnace recipes for the early tech tree and the common
 * ore/food cases. 35 results; not a complete vanilla smelting list, and no
 * blasting/smoking/campfire variants.
 */
const SMELTING: readonly { result: string; inputs: readonly string[] }[] = [
  {
    result: 'iron_ingot',
    inputs: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  },
  {
    result: 'gold_ingot',
    inputs: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  },
  {
    result: 'copper_ingot',
    inputs: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  },
  { result: 'glass', inputs: ['sand', 'red_sand'] },
  {
    result: 'charcoal',
    inputs: [
      'oak_log',
      'birch_log',
      'spruce_log',
      'jungle_log',
      'acacia_log',
      'dark_oak_log',
      'mangrove_log',
      'cherry_log',
    ],
  },
  { result: 'stone', inputs: ['cobblestone'] },
  { result: 'smooth_stone', inputs: ['stone'] },
  { result: 'deepslate', inputs: ['cobbled_deepslate'] },
  { result: 'brick', inputs: ['clay_ball'] },
  { result: 'terracotta', inputs: ['clay'] },
  { result: 'cracked_stone_bricks', inputs: ['stone_bricks'] },
  { result: 'cracked_deepslate_bricks', inputs: ['deepslate_bricks'] },
  { result: 'cracked_nether_bricks', inputs: ['nether_bricks'] },
  { result: 'smooth_sandstone', inputs: ['sandstone'] },
  { result: 'smooth_red_sandstone', inputs: ['red_sandstone'] },
  { result: 'smooth_quartz', inputs: ['quartz_block'] },
  { result: 'quartz', inputs: ['nether_quartz_ore'] },
  { result: 'diamond', inputs: ['diamond_ore', 'deepslate_diamond_ore'] },
  { result: 'emerald', inputs: ['emerald_ore', 'deepslate_emerald_ore'] },
  { result: 'lapis_lazuli', inputs: ['lapis_ore', 'deepslate_lapis_ore'] },
  { result: 'redstone', inputs: ['redstone_ore', 'deepslate_redstone_ore'] },
  { result: 'coal', inputs: ['coal_ore', 'deepslate_coal_ore'] },
  { result: 'netherite_scrap', inputs: ['ancient_debris'] },
  { result: 'green_dye', inputs: ['cactus'] },
  { result: 'dried_kelp', inputs: ['kelp'] },
  { result: 'popped_chorus_fruit', inputs: ['chorus_fruit'] },
  { result: 'baked_potato', inputs: ['potato'] },
  { result: 'sponge', inputs: ['wet_sponge'] },
  { result: 'cooked_beef', inputs: ['beef'] },
  { result: 'cooked_porkchop', inputs: ['porkchop'] },
  { result: 'cooked_chicken', inputs: ['chicken'] },
  { result: 'cooked_mutton', inputs: ['mutton'] },
  { result: 'cooked_rabbit', inputs: ['rabbit'] },
  { result: 'cooked_cod', inputs: ['cod'] },
  { result: 'cooked_salmon', inputs: ['salmon'] },
];

/**
 * Items preferred when several recipe variants are otherwise equivalent.
 *
 * Sticks can be made from any of eleven plank types; without a stated
 * preference the "canonical" recipe would be whichever one happens to sort
 * first, which is a silly thing for a test suite to depend on. Oak is the
 * conventional default in every Minecraft tutorial and benchmark.
 */
const PREFERRED_INGREDIENT_PREFIXES: readonly string[] = ['oak_'];

/** Raw shapes as they appear in `minecraft-data`'s `recipes.json`. */
interface RawResult {
  readonly id: number;
  readonly count?: number;
}
interface RawRecipe {
  readonly result: RawResult | number;
  readonly ingredients?: readonly (number | null)[];
  readonly inShape?: readonly (readonly (number | null)[])[];
}

function isPreferred(item: string): boolean {
  return PREFERRED_INGREDIENT_PREFIXES.some((p) => item.startsWith(p));
}

/**
 * Rank recipes so that `craftingRecipes` is deterministic and its first entry
 * is the sane default: most output per craft, then fewest distinct ingredients,
 * then fewest total units, then the oak-ish variant, then alphabetical.
 */
function rankKey(
  r: CraftingRecipe,
): readonly [number, number, number, number, string] {
  const totalUnits = r.ingredients.reduce((s, i) => s + i.count, 0);
  const preferred = r.ingredients.some((i) => isPreferred(i.item)) ? 0 : 1;
  const key = r.ingredients.map((i) => `${i.item}:${i.count}`).join(',');
  return [-r.resultCount, r.ingredients.length, totalUnits, preferred, key];
}

function compareRecipes(a: CraftingRecipe, b: CraftingRecipe): number {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i]!;
    const y = kb[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export class RecipeBook {
  readonly version: string;
  /** Smelting entries whose result or every input is unknown at this version. */
  readonly droppedSmeltingEntries: readonly string[];

  readonly #crafting: ReadonlyMap<string, readonly CraftingRecipe[]>;
  readonly #smelting: ReadonlyMap<string, SmeltingRecipe>;
  readonly #items: ReadonlySet<string>;

  private constructor(
    version: string,
    crafting: ReadonlyMap<string, readonly CraftingRecipe[]>,
    smelting: ReadonlyMap<string, SmeltingRecipe>,
    items: ReadonlySet<string>,
    dropped: readonly string[],
  ) {
    this.version = version;
    this.#crafting = crafting;
    this.#smelting = smelting;
    this.#items = items;
    this.droppedSmeltingEntries = dropped;
  }

  /**
   * Load and normalise the recipe data for a version.
   *
   * Results are cached per version: `minecraft-data` parses a few megabytes of
   * JSON, and a test suite that rebuilds the book per case pays for it.
   */
  static forVersion(version: string = DEFAULT_MINECRAFT_VERSION): RecipeBook {
    const cached = bookCache.get(version);
    if (cached) return cached;
    const parts = buildBook(version);
    const built = new RecipeBook(
      version,
      parts.crafting,
      parts.smelting,
      parts.items,
      parts.dropped,
    );
    bookCache.set(version, built);
    return built;
  }

  /**
   * Build a book from explicit tables rather than from `minecraft-data`.
   *
   * For contrived graphs: a two-item cycle, a recipe that names itself, a tech
   * tree small enough to reason about by hand. Real Minecraft data contains
   * these shapes but not on demand and not in isolation.
   */
  static fromTables(spec: {
    readonly version?: string;
    readonly crafting?: readonly {
      readonly result: string;
      readonly resultCount?: number;
      readonly ingredients: readonly Ingredient[];
      readonly shape?: 'shaped' | 'shapeless';
      readonly requiresCraftingTable?: boolean;
    }[];
    readonly smelting?: readonly {
      readonly result: string;
      readonly inputs: readonly string[];
      readonly resultCount?: number;
    }[];
    /** Extra item names that exist but nothing produces. */
    readonly items?: Iterable<string>;
  }): RecipeBook {
    const items = new Set<string>(spec.items ?? []);
    const crafting = new Map<string, CraftingRecipe[]>();
    for (const entry of spec.crafting ?? []) {
      const recipe: CraftingRecipe = {
        result: entry.result,
        resultCount: entry.resultCount ?? 1,
        ingredients: [...entry.ingredients].sort((a, b) =>
          a.item < b.item ? -1 : a.item > b.item ? 1 : 0,
        ),
        shape: entry.shape ?? 'shapeless',
        requiresCraftingTable: entry.requiresCraftingTable ?? false,
      };
      items.add(recipe.result);
      for (const i of recipe.ingredients) items.add(i.item);
      const bucket = crafting.get(recipe.result);
      if (bucket) bucket.push(recipe);
      else crafting.set(recipe.result, [recipe]);
    }
    for (const bucket of crafting.values()) bucket.sort(compareRecipes);

    const smelting = new Map<string, SmeltingRecipe>();
    for (const entry of spec.smelting ?? []) {
      items.add(entry.result);
      for (const i of entry.inputs) items.add(i);
      smelting.set(entry.result, {
        result: entry.result,
        resultCount: entry.resultCount ?? 1,
        inputs: [...entry.inputs],
      });
    }

    return new RecipeBook(
      spec.version ?? 'synthetic',
      crafting,
      smelting,
      items,
      [],
    );
  }

  /** True when the pinned version knows this item name at all. */
  knowsItem(item: string): boolean {
    return this.#items.has(item);
  }

  /** All crafting recipes producing `item`, best default first. */
  craftingRecipes(item: string): readonly CraftingRecipe[] {
    return this.#crafting.get(item) ?? [];
  }

  /** The default crafting recipe for `item`, if any. */
  craftingRecipe(item: string): CraftingRecipe | undefined {
    return this.craftingRecipes(item)[0];
  }

  smeltingRecipe(item: string): SmeltingRecipe | undefined {
    return this.#smelting.get(item);
  }

  /** Every item this book can produce by crafting or smelting. */
  producibleItems(): readonly string[] {
    return [
      ...new Set([...this.#crafting.keys(), ...this.#smelting.keys()]),
    ].sort();
  }

  isCraftable(item: string): boolean {
    return this.#crafting.has(item) || this.#smelting.has(item);
  }

  /** True when no 2x2-grid recipe for `item` exists. */
  requiresCraftingTable(item: string): boolean {
    const recipes = this.craftingRecipes(item);
    if (recipes.length === 0) return false;
    return recipes.every((r) => r.requiresCraftingTable);
  }

  /**
   * Direct ingredients for producing at least `count` of `item`, using the
   * default recipe.
   *
   * Counts are rounded up to whole crafts: asking for one stick costs two
   * planks and yields four sticks, because the grid does not do fractions.
   * Returns `undefined` when nothing crafts `item` (smelting is not consulted;
   * use `smeltingRecipe`).
   */
  ingredientsFor(
    item: string,
    count = 1,
    recipe: CraftingRecipe | undefined = this.craftingRecipe(item),
  ): readonly Ingredient[] | undefined {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }
    if (!recipe) return undefined;
    const batches = Math.ceil(count / recipe.resultCount);
    return recipe.ingredients.map((i) => ({
      item: i.item,
      count: i.count * batches,
    }));
  }
}

const bookCache = new Map<string, RecipeBook>();

interface BookParts {
  readonly crafting: ReadonlyMap<string, readonly CraftingRecipe[]>;
  readonly smelting: ReadonlyMap<string, SmeltingRecipe>;
  readonly items: ReadonlySet<string>;
  readonly dropped: readonly string[];
}

function buildBook(version: string): BookParts {
  const data = minecraftData(version);
  if (!data) {
    throw new Error(`minecraft-data has no data for version ${version}`);
  }
  const nameById = new Map<number, string>();
  const items = new Set<string>();
  for (const item of data.itemsArray) {
    nameById.set(item.id, item.name);
    items.add(item.name);
  }
  // Some craftable results are only registered as blocks in a given version.
  for (const block of data.blocksArray) {
    if (!nameById.has(block.id)) nameById.set(block.id, block.name);
    items.add(block.name);
  }

  const crafting = new Map<string, CraftingRecipe[]>();
  const rawRecipes = data.recipes as unknown as Record<string, RawRecipe[]>;
  for (const list of Object.values(rawRecipes)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const recipe = normalise(raw, nameById);
      if (!recipe) continue;
      const bucket = crafting.get(recipe.result);
      if (bucket) bucket.push(recipe);
      else crafting.set(recipe.result, [recipe]);
    }
  }
  for (const bucket of crafting.values()) {
    bucket.sort(compareRecipes);
  }

  const smelting = new Map<string, SmeltingRecipe>();
  const dropped: string[] = [];
  for (const entry of SMELTING) {
    const inputs = entry.inputs.filter((i) => items.has(i));
    if (!items.has(entry.result) || inputs.length === 0) {
      dropped.push(entry.result);
      continue;
    }
    smelting.set(entry.result, {
      result: entry.result,
      resultCount: 1,
      inputs,
    });
  }

  return { crafting, smelting, items, dropped };
}

function normalise(
  raw: RawRecipe,
  nameById: ReadonlyMap<number, string>,
): CraftingRecipe | undefined {
  const resultId = typeof raw.result === 'number' ? raw.result : raw.result.id;
  const resultCount =
    typeof raw.result === 'number' ? 1 : (raw.result.count ?? 1);
  const result = nameById.get(resultId);
  if (result === undefined || resultCount <= 0) return undefined;

  const counts = new Map<string, number>();
  let shape: 'shaped' | 'shapeless';
  let requiresCraftingTable: boolean;

  if (raw.inShape) {
    shape = 'shaped';
    const height = raw.inShape.length;
    let width = 0;
    for (const row of raw.inShape) {
      width = Math.max(width, row.length);
      for (const cell of row) {
        if (cell === null || cell === undefined) continue;
        const name = nameById.get(cell);
        if (name === undefined) return undefined;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    requiresCraftingTable = width > 2 || height > 2;
  } else if (raw.ingredients) {
    shape = 'shapeless';
    for (const cell of raw.ingredients) {
      if (cell === null || cell === undefined) continue;
      const name = nameById.get(cell);
      if (name === undefined) return undefined;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let slots = 0;
    for (const n of counts.values()) slots += n;
    requiresCraftingTable = slots > 4;
  } else {
    return undefined;
  }

  if (counts.size === 0) return undefined;

  const ingredients: Ingredient[] = [...counts.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  return { result, resultCount, ingredients, shape, requiresCraftingTable };
}
