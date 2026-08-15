import type { SymbolicTask, TaskGoal } from './task.js';
import type { ActionRefusal, ActionResult, SymbolicWorld } from './world.js';
import type { RecipeBook } from './recipes.js';
import { TechTree } from './techtree.js';

/**
 * Runs a policy against a task under a step budget.
 *
 * The policy is a plain function, not a class or an agent. Anything that can
 * look at a world and name an action can be measured here: a hand-written
 * baseline, a planner, or a transcript replayed from a language model.
 */

export type Action =
  | {
      readonly kind: 'mine';
      readonly resource: string;
      readonly count?: number;
    }
  | { readonly kind: 'craft'; readonly item: string; readonly count?: number }
  | { readonly kind: 'smelt'; readonly item: string; readonly count?: number }
  /**
   * Declare the task finished or unreachable. On an `impossible` task this is
   * the only correct answer, which is why it is an action and not a return of
   * `undefined`: refusing has to be something a policy does on purpose.
   */
  | { readonly kind: 'stop'; readonly reason?: string };

export type Policy = (world: SymbolicWorld, step: number) => Action;

export type RunOutcome =
  /** The goal predicate held. */
  | 'goal-reached'
  /** The policy stopped. Correct on an impossible task, a give-up otherwise. */
  | 'refused'
  /** The step budget ran out with the goal unmet. */
  | 'budget-exhausted'
  /** The policy threw. */
  | 'policy-error';

export interface StepRecord {
  readonly step: number;
  readonly action: Action;
  readonly result: ActionResult | undefined;
}

export interface RunResult {
  readonly taskId: string;
  readonly outcome: RunOutcome;
  /**
   * True when the policy did the right thing: reached the goal on a solvable
   * task, or refused on an impossible one.
   */
  readonly success: boolean;
  readonly stepsUsed: number;
  /** The last action the world refused, if any. */
  readonly refusal: ActionRefusal | undefined;
  /** Set when the policy stopped, carrying its stated reason. */
  readonly stopReason: string | undefined;
  /** Set when the policy threw. */
  readonly error: Error | undefined;
  readonly log: readonly StepRecord[];
  /** The world as the run left it. */
  readonly world: SymbolicWorld;
}

export interface RunOptions {
  /** End the run on the first refused action. Defaults to false. */
  readonly stopOnRefusal?: boolean;
  /** Overrides the task's budget. */
  readonly stepBudget?: number;
  /** Cap used when neither the task nor the options give a budget. */
  readonly defaultStepBudget?: number;
  readonly recipes?: RecipeBook;
}

const FALLBACK_BUDGET = 256;

export function runTask(
  task: SymbolicTask,
  policy: Policy,
  options: RunOptions = {},
): RunResult {
  const world = task.createWorld(options.recipes);
  const budget =
    options.stepBudget ??
    task.stepBudget ??
    options.defaultStepBudget ??
    FALLBACK_BUDGET;

  const log: StepRecord[] = [];
  let refusal: ActionRefusal | undefined;
  let stepsUsed = 0;

  const finish = (
    outcome: RunOutcome,
    success: boolean,
    extra: { stopReason?: string; error?: Error } = {},
  ): RunResult => ({
    taskId: task.id,
    outcome,
    success,
    stepsUsed,
    refusal,
    stopReason: extra.stopReason,
    error: extra.error,
    log,
    world,
  });

  while (stepsUsed < budget) {
    if (task.check(world)) {
      return finish('goal-reached', !task.impossible);
    }

    let action: Action;
    try {
      action = policy(world, stepsUsed);
    } catch (err) {
      return finish('policy-error', false, {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }

    if (action.kind === 'stop') {
      log.push({ step: stepsUsed, action, result: undefined });
      // Stopping on a solvable task counts only if the goal is already met,
      // which the check above would have caught, so this is a give-up.
      return finish('refused', task.impossible, {
        ...(action.reason !== undefined ? { stopReason: action.reason } : {}),
      });
    }

    const result = applyAction(world, action);
    stepsUsed += 1;
    log.push({ step: stepsUsed - 1, action, result });
    if (!result.ok) {
      refusal = result;
      if (options.stopOnRefusal === true) {
        return finish('budget-exhausted', false);
      }
    }
  }

  if (task.check(world)) {
    return finish('goal-reached', !task.impossible);
  }
  return finish('budget-exhausted', false);
}

/**
 * A baseline policy: replan from the current inventory every step, mine what
 * the plan says is missing, and stop when the goal is unreachable.
 *
 * It exists to give the benchmark a floor and to prove the substrate is usable
 * without an agent attached. It replans rather than executing a cached plan
 * because that is the honest reading of a world that can refuse.
 */
export function planningPolicy(goal: TaskGoal, tree = new TechTree()): Policy {
  return (world: SymbolicWorld): Action => {
    const plan = tree.craftingPlan(goal.item, goal.count, world.inventory, {
      gatherable: Object.keys(world.resources()),
    });

    if (!plan.ok) {
      if (plan.reason !== 'missing-materials') {
        return { kind: 'stop', reason: plan.reason };
      }
      for (const need of plan.missing) {
        const nearby = world.resourceCount(need.item);
        if (nearby > 0) {
          return {
            kind: 'mine',
            resource: need.item,
            count: Math.min(need.count, nearby),
          };
        }
      }
      return {
        kind: 'stop',
        reason: `cannot obtain ${plan.missing.map((m) => `${m.count} ${m.item}`).join(', ')}`,
      };
    }

    const next = plan.steps[0];
    if (!next) {
      return { kind: 'stop', reason: 'nothing left to do' };
    }
    if (next.kind === 'smelt' && !world.furnaceInReach) {
      return { kind: 'stop', reason: 'no furnace in reach' };
    }
    if (
      next.kind === 'craft' &&
      next.requiresCraftingTable &&
      !world.craftingTableInReach
    ) {
      return { kind: 'stop', reason: 'no crafting table in reach' };
    }
    return { kind: next.kind, item: next.item, count: next.produces };
  };
}

function applyAction(
  world: SymbolicWorld,
  action: Exclude<Action, { kind: 'stop' }>,
): ActionResult {
  switch (action.kind) {
    case 'mine':
      return world.mine(action.resource, action.count ?? 1);
    case 'craft':
      return world.craft(action.item, action.count ?? 1);
    case 'smelt':
      return world.smelt(action.item, action.count ?? 1);
  }
}
