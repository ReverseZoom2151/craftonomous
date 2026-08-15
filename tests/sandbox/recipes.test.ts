import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MINECRAFT_VERSION,
  RecipeBook,
} from '../../src/sandbox/recipes.js';

const book = RecipeBook.forVersion();

describe('RecipeBook loading', () => {
  it('exposes the version it derived its data from', () => {
    expect(book.version).toBe(DEFAULT_MINECRAFT_VERSION);
  });

  it('caches per version so a suite does not reparse megabytes of JSON', () => {
    expect(RecipeBook.forVersion()).toBe(book);
  });

  it('refuses a version minecraft-data does not carry', () => {
    expect(() => RecipeBook.forVersion('0.0.0')).toThrow();
  });

  it('recognises every item its hand-written smelting table names', () => {
    // If this fails, the curated table has drifted from the pinned version.
    expect(book.droppedSmeltingEntries).toEqual([]);
  });

  it('derives a large recipe set rather than a hand-written stub', () => {
    expect(book.producibleItems().length).toBeGreaterThan(500);
  });
});

describe('crafting recipes derived from minecraft-data', () => {
  it('turns one log into four planks', () => {
    const recipe = book.craftingRecipe('oak_planks');
    expect(recipe).toBeDefined();
    expect(recipe?.resultCount).toBe(4);
    expect(recipe?.ingredients).toEqual([{ item: 'oak_log', count: 1 }]);
    expect(recipe?.requiresCraftingTable).toBe(false);
  });

  it('turns two planks into four sticks', () => {
    const recipe = book.craftingRecipe('stick');
    expect(recipe?.resultCount).toBe(4);
    expect(recipe?.ingredients).toEqual([{ item: 'oak_planks', count: 2 }]);
    expect(recipe?.requiresCraftingTable).toBe(false);
  });

  it('aggregates a shaped grid into an ingredient multiset', () => {
    const recipe = book.craftingRecipe('wooden_pickaxe');
    expect(recipe?.shape).toBe('shaped');
    expect(recipe?.ingredients).toEqual([
      { item: 'oak_planks', count: 3 },
      { item: 'stick', count: 2 },
    ]);
  });

  it('keeps every wood variant, not just the preferred one', () => {
    const variants = book.craftingRecipes('stick');
    const woods = variants.flatMap((r) => r.ingredients.map((i) => i.item));
    expect(woods).toContain('birch_planks');
    expect(woods).toContain('spruce_planks');
    expect(variants.length).toBeGreaterThan(5);
  });

  it('ranks the best default first: most output, then oak', () => {
    // Bamboo also makes sticks, one at a time. It must not win.
    const first = book.craftingRecipes('stick')[0];
    expect(first?.resultCount).toBe(4);
    expect(first?.ingredients[0]?.item).toBe('oak_planks');
  });

  it('is deterministic across loads', () => {
    const again = RecipeBook.forVersion(DEFAULT_MINECRAFT_VERSION);
    expect(again.craftingRecipes('wooden_pickaxe')[0]).toEqual(
      book.craftingRecipes('wooden_pickaxe')[0],
    );
  });

  it('returns an empty list for a raw material', () => {
    expect(book.craftingRecipes('oak_log')).toEqual([]);
    expect(book.craftingRecipe('oak_log')).toBeUndefined();
  });
});

describe('crafting table requirement', () => {
  it('does not need a table for a 2x2 recipe', () => {
    expect(book.requiresCraftingTable('oak_planks')).toBe(false);
    expect(book.requiresCraftingTable('stick')).toBe(false);
    expect(book.requiresCraftingTable('crafting_table')).toBe(false);
  });

  it('needs a table for anything using the 3x3 grid', () => {
    expect(book.requiresCraftingTable('wooden_pickaxe')).toBe(true);
    expect(book.requiresCraftingTable('furnace')).toBe(true);
    expect(book.requiresCraftingTable('chest')).toBe(true);
  });

  it('treats a shapeless recipe of more than four inputs as 3x3', () => {
    const ingotFromBlock = book
      .craftingRecipes('iron_ingot')
      .find((r) => r.shape === 'shapeless');
    expect(ingotFromBlock?.requiresCraftingTable).toBe(false);
  });
});

describe('ingredientsFor', () => {
  it('scales to whole crafts, rounding up', () => {
    expect(book.ingredientsFor('stick', 1)).toEqual([
      { item: 'oak_planks', count: 2 },
    ]);
    expect(book.ingredientsFor('stick', 4)).toEqual([
      { item: 'oak_planks', count: 2 },
    ]);
    expect(book.ingredientsFor('stick', 5)).toEqual([
      { item: 'oak_planks', count: 4 },
    ]);
  });

  it('scales a multi-ingredient recipe', () => {
    expect(book.ingredientsFor('wooden_pickaxe', 2)).toEqual([
      { item: 'oak_planks', count: 6 },
      { item: 'stick', count: 4 },
    ]);
  });

  it('answers undefined for something nothing crafts', () => {
    expect(book.ingredientsFor('oak_log', 1)).toBeUndefined();
  });

  it('refuses a non-positive count', () => {
    expect(() => book.ingredientsFor('stick', 0)).toThrow(RangeError);
    expect(() => book.ingredientsFor('stick', -2)).toThrow(RangeError);
  });

  it('accepts an explicit recipe variant', () => {
    const birch = book
      .craftingRecipes('stick')
      .find((r) => r.ingredients[0]?.item === 'birch_planks');
    expect(book.ingredientsFor('stick', 8, birch)).toEqual([
      { item: 'birch_planks', count: 4 },
    ]);
  });
});

describe('smelting (hand-authored, see SMELTING in recipes.ts)', () => {
  it('smelts raw iron into an ingot', () => {
    const recipe = book.smeltingRecipe('iron_ingot');
    expect(recipe?.resultCount).toBe(1);
    expect(recipe?.inputs[0]).toBe('raw_iron');
    expect(recipe?.inputs).toContain('iron_ore');
  });

  it('accepts every ore variant that yields the same result', () => {
    expect(book.smeltingRecipe('gold_ingot')?.inputs).toContain(
      'deepslate_gold_ore',
    );
  });

  it('smelts sand into glass and cobblestone into stone', () => {
    expect(book.smeltingRecipe('glass')?.inputs).toContain('sand');
    expect(book.smeltingRecipe('stone')?.inputs).toEqual(['cobblestone']);
  });

  it('has nothing for an item vanilla does not smelt', () => {
    expect(book.smeltingRecipe('stick')).toBeUndefined();
    expect(book.smeltingRecipe('oak_log')).toBeUndefined();
  });

  it('counts craftable and smeltable both as producible', () => {
    expect(book.isCraftable('stick')).toBe(true);
    expect(book.isCraftable('iron_ingot')).toBe(true);
    expect(book.isCraftable('oak_log')).toBe(false);
  });
});

describe('item registry', () => {
  it('knows real item names', () => {
    expect(book.knowsItem('oak_log')).toBe(true);
    expect(book.knowsItem('diamond_pickaxe')).toBe(true);
  });

  it('does not know invented ones', () => {
    expect(book.knowsItem('unobtainium')).toBe(false);
  });
});

describe('RecipeBook.fromTables', () => {
  it('builds a book from explicit tables', () => {
    const synthetic = RecipeBook.fromTables({
      crafting: [
        {
          result: 'widget',
          resultCount: 2,
          ingredients: [{ item: 'cog', count: 3 }],
        },
      ],
      smelting: [{ result: 'cog', inputs: ['ore'] }],
      items: ['ore'],
    });
    expect(synthetic.version).toBe('synthetic');
    expect(synthetic.ingredientsFor('widget', 3)).toEqual([
      { item: 'cog', count: 6 },
    ]);
    expect(synthetic.smeltingRecipe('cog')?.inputs).toEqual(['ore']);
    expect(synthetic.knowsItem('ore')).toBe(true);
    expect(synthetic.isCraftable('ore')).toBe(false);
  });
});
