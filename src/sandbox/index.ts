/**
 * The offline symbolic sandbox: Minecraft's crafting, smelting and gathering
 * rules with no server, no Java and no network.
 *
 * Prior art is consistent that this is the cheapest way to make agent
 * evaluation reproducible (plancraft and MC-TextWorld both reach for it) and
 * it is the only tier of the benchmark that can run on every commit.
 */

export type { ItemCounts } from './inventory.js';
export { Inventory } from './inventory.js';

export type { CraftingRecipe, Ingredient, SmeltingRecipe } from './recipes.js';
export { DEFAULT_MINECRAFT_VERSION, RecipeBook } from './recipes.js';

export type {
  CraftStep,
  DependencyOptions,
  MissingMaterial,
  PlanFailure,
  PlanOptions,
  PlanResult,
  PlanStep,
  PlanSuccess,
  SmeltStep,
} from './techtree.js';
export { TechTree } from './techtree.js';

export type {
  ActionKind,
  ActionRefusal,
  ActionResult,
  ActionSuccess,
  RefusalReason,
  SymbolicWorldSpec,
} from './world.js';
export { SymbolicWorld } from './world.js';

export type { SymbolicTask, SymbolicTaskSpec, TaskGoal } from './task.js';
export { STARTER_TASKS, defineTask, taskById } from './task.js';

export type {
  Action,
  Policy,
  RunOptions,
  RunOutcome,
  RunResult,
  StepRecord,
} from './runner.js';
export { planningPolicy, runTask } from './runner.js';
