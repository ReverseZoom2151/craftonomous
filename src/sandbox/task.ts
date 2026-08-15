import type { ItemCounts } from './inventory.js';
import type { RecipeBook } from './recipes.js';
import { SymbolicWorld } from './world.js';

/**
 * A symbolic task: a starting world, a goal, and a budget.
 *
 * `impossible` is the point of the type. A benchmark made only of solvable
 * tasks rewards an agent for trying things until something works, and cannot
 * distinguish planning from guessing. An agent that recognises an unreachable
 * goal and refuses is doing the harder thing, so the suite has to contain goals
 * that cannot be reached and has to score refusal as the correct answer.
 */

export interface TaskGoal {
  readonly item: string;
  readonly count: number;
}

export interface SymbolicTaskSpec {
  readonly id: string;
  readonly description: string;
  readonly goal: TaskGoal;
  readonly startingInventory?: ItemCounts;
  /** Nearby deposits and their finite quantities. */
  readonly resources?: ItemCounts;
  readonly biome?: string;
  readonly craftingTable?: boolean;
  readonly furnace?: boolean;
  /** Maximum actions the runner will allow. Omitted means unbounded. */
  readonly stepBudget?: number;
  /** True when the goal cannot be reached from this starting world. */
  readonly impossible?: boolean;
  /** Overrides the default "holds enough of the goal item" predicate. */
  readonly check?: (world: SymbolicWorld) => boolean;
}

export interface SymbolicTask {
  readonly id: string;
  readonly description: string;
  readonly goal: TaskGoal;
  readonly startingInventory: ItemCounts;
  readonly resources: ItemCounts;
  readonly biome: string;
  readonly craftingTable: boolean;
  readonly furnace: boolean;
  readonly stepBudget: number | undefined;
  readonly impossible: boolean;
  /** True when the world satisfies the goal. */
  check(world: SymbolicWorld): boolean;
  /** A fresh world in the task's starting state. */
  createWorld(recipes?: RecipeBook): SymbolicWorld;
}

export function defineTask(spec: SymbolicTaskSpec): SymbolicTask {
  if (!Number.isInteger(spec.goal.count) || spec.goal.count <= 0) {
    throw new RangeError(
      `task ${spec.id}: goal count must be a positive integer`,
    );
  }
  if (
    spec.stepBudget !== undefined &&
    (!Number.isInteger(spec.stepBudget) || spec.stepBudget <= 0)
  ) {
    throw new RangeError(
      `task ${spec.id}: step budget must be a positive integer`,
    );
  }

  const startingInventory = { ...(spec.startingInventory ?? {}) };
  const resources = { ...(spec.resources ?? {}) };
  const biome = spec.biome ?? 'plains';
  const craftingTable = spec.craftingTable ?? false;
  const furnace = spec.furnace ?? false;
  const check =
    spec.check ??
    ((world: SymbolicWorld): boolean =>
      world.inventory.has(spec.goal.item, spec.goal.count));

  return {
    id: spec.id,
    description: spec.description,
    goal: spec.goal,
    startingInventory,
    resources,
    biome,
    craftingTable,
    furnace,
    stepBudget: spec.stepBudget,
    impossible: spec.impossible ?? false,
    check,
    createWorld(recipes?: RecipeBook): SymbolicWorld {
      return new SymbolicWorld({
        inventory: startingInventory,
        resources,
        biome,
        craftingTable,
        furnace,
        ...(recipes ? { recipes } : {}),
      });
    },
  };
}

/**
 * A small starter set covering the shapes the runner has to handle: gather then
 * craft, a multi-step chain, a smelt, a station that is absent, a deposit that
 * runs out, and a goal that is flatly unreachable.
 */
export const STARTER_TASKS: readonly SymbolicTask[] = [
  defineTask({
    id: 'planks-from-logs',
    description: 'Mine an oak log and turn it into planks.',
    goal: { item: 'oak_planks', count: 4 },
    resources: { oak_log: 8 },
    stepBudget: 8,
  }),
  defineTask({
    id: 'wooden-pickaxe',
    description:
      'From bare hands and a forest, reach a wooden pickaxe: log, planks, sticks, pickaxe.',
    goal: { item: 'wooden_pickaxe', count: 1 },
    resources: { oak_log: 8 },
    craftingTable: true,
    stepBudget: 16,
  }),
  defineTask({
    id: 'iron-ingot-from-ore',
    description: 'Smelt raw iron into an ingot with a furnace in reach.',
    goal: { item: 'iron_ingot', count: 2 },
    startingInventory: { raw_iron: 2 },
    furnace: true,
    stepBudget: 4,
  }),
  defineTask({
    id: 'pickaxe-without-a-table',
    description:
      'A wooden pickaxe with no crafting table in reach. Every recipe for it needs a 3x3 grid.',
    goal: { item: 'wooden_pickaxe', count: 1 },
    startingInventory: { oak_planks: 8, stick: 4 },
    craftingTable: false,
    impossible: true,
    stepBudget: 8,
  }),
  defineTask({
    id: 'not-enough-wood',
    description:
      'A crafting table needs four planks; one log yields four, and only one log is nearby, so the pickaxe cannot follow.',
    goal: { item: 'wooden_pickaxe', count: 1 },
    resources: { oak_log: 1 },
    craftingTable: true,
    impossible: true,
    stepBudget: 12,
  }),
  defineTask({
    id: 'diamond-from-a-forest',
    description:
      'A diamond pickaxe with nothing but wood nearby. Nothing in the recipe graph turns logs into diamonds.',
    goal: { item: 'diamond_pickaxe', count: 1 },
    resources: { oak_log: 64 },
    craftingTable: true,
    impossible: true,
    stepBudget: 32,
  }),
];

export function taskById(id: string): SymbolicTask | undefined {
  return STARTER_TASKS.find((t) => t.id === id);
}
