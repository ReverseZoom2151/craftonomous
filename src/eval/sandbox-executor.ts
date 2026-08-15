/**
 * The offline tier: scoring the eval suites against the symbolic sandbox.
 *
 * `src/eval/` and `src/sandbox/` were built to the same brief and never
 * connected. The sandbox has its own policy type over `SymbolicWorld`, the
 * harness has `TaskExecutor` over `Task`, and nothing bridged them, so both
 * halves were tested only against themselves. This module is the bridge, and it
 * is the more useful of the two executors today: it needs no server, no Java
 * and no network, so a suite score can be produced in CI on every commit.
 *
 * Outcome mapping is deliberately identical to `live.ts`, including the
 * refusal test, so that a task scored offline and the same task scored against
 * a server mean the same thing by `refused`.
 *
 * ## What the offline tier honestly cannot measure
 *
 * The sandbox has no positions, no altitude and no placement action. Three
 * shipped goals therefore cannot be evaluated here at all: the crafting table
 * placement goal, the shelter goal, and the altitude goal. Those attempts
 * return `error` and say why. They are not returned as `failure`: an agent that
 * was never given a world in which the goal is expressible has not failed.
 *
 * The sandbox also cannot invent a starting world. A `Task` carries a goal, a
 * budget and a profile, and nothing about biome, deposits or starting
 * inventory. So a scenario per task is a capability the caller provides, and a
 * task with no scenario is reported as an `error` rather than quietly run
 * against an empty plain.
 */

import type { ItemCounts } from '../sandbox/inventory.js';
import type { RecipeBook } from '../sandbox/recipes.js';
import type { Policy as SandboxPolicy, RunResult } from '../sandbox/runner.js';
import { runTask } from '../sandbox/runner.js';
import { defineTask as defineSymbolicTask } from '../sandbox/task.js';
import type { SymbolicWorld } from '../sandbox/world.js';
import type { Clock } from '../runtime/clock.js';
import { systemClock } from '../runtime/clock.js';
import type { GoalPredicate, GoalPredicateOverrides } from './goal-check.js';
import { checkPredicateAgainstItems, predicateFor } from './goal-check.js';
import { declaresImpossible } from './live.js';
import type { AttemptContext, TaskExecutor } from './runner.js';
import type { TaskOutcome } from './scoring.js';
import type { Task } from './task.js';

/** The starting world for one eval task, in the sandbox's own terms. */
export interface SandboxScenario {
  readonly startingInventory?: ItemCounts;
  /** Nearby deposits and their finite quantities. */
  readonly resources?: ItemCounts;
  readonly biome?: string;
  readonly craftingTable?: boolean;
  readonly furnace?: boolean;
  readonly recipes?: RecipeBook;
}

export interface SandboxAttemptRecord {
  readonly taskId: string;
  readonly repeat: number;
  readonly seed: number;
  readonly outcome: TaskOutcome;
  readonly predicate: GoalPredicate | undefined;
  /** The sandbox run, when one happened. */
  readonly run: RunResult | undefined;
}

export type RecordingSandboxExecutor = TaskExecutor & {
  readonly records: readonly SandboxAttemptRecord[];
};

export interface SandboxExecutorDeps {
  /** The agent under test, in sandbox terms. Mutually exclusive with `policyFor`. */
  readonly policy?: SandboxPolicy;
  /**
   * A policy built per task. Given the predicate as well as the task, because a
   * policy that cannot see what it is being scored on is being asked to guess.
   *
   * Kept as a separate field rather than a union with `policy`: a sandbox
   * `Policy` and a policy factory are both two-argument functions, so no
   * run-time test could tell them apart, and guessing wrong would silently run
   * the wrong thing.
   */
  readonly policyFor?: (task: Task, predicate: GoalPredicate) => SandboxPolicy;
  /**
   * The starting world for a task. Returning `undefined` reports the task as
   * unscorable in this tier rather than running it against an empty world.
   */
  readonly scenario: (
    task: Task,
    context: AttemptContext,
  ) => SandboxScenario | undefined;
  readonly goalPredicates?: GoalPredicateOverrides;
  /** End the run on the first refused action. Defaults to false. */
  readonly stopOnRefusal?: boolean;
  readonly clock?: Clock;
  readonly onAttempt?: (record: SandboxAttemptRecord) => void;
}

/**
 * A representative item for the sandbox's own `TaskGoal`.
 *
 * `runTask` never reads it (the predicate below is what decides the goal), but
 * `defineTask` validates it, and a policy built by `planningPolicy` plans
 * towards it. For a tag goal the first member is used, which is a real choice
 * and is why tag membership is ordered rather than a set.
 */
function representativeGoal(
  predicate: GoalPredicate,
): { item: string; count: number } | undefined {
  switch (predicate.kind) {
    case 'item-count':
      return { item: predicate.item, count: predicate.count };
    case 'item-tag-count': {
      const first = predicate.items[0];
      return first === undefined
        ? undefined
        : { item: first, count: predicate.count };
    }
    default:
      return undefined;
  }
}

function errorOutcome(detail: string, durationMs: number): TaskOutcome {
  return { kind: 'error', steps: 0, durationMs, detail };
}

export function createSandboxExecutor(
  deps: SandboxExecutorDeps,
): RecordingSandboxExecutor {
  if ((deps.policy === undefined) === (deps.policyFor === undefined)) {
    throw new Error(
      'createSandboxExecutor needs exactly one of `policy` or `policyFor`',
    );
  }
  const records: SandboxAttemptRecord[] = [];
  const clock = deps.clock ?? systemClock;

  const executor = async (
    task: Task,
    context: AttemptContext,
  ): Promise<TaskOutcome> => {
    const startedAt = clock.now();

    const finish = (
      outcome: TaskOutcome,
      predicate: GoalPredicate | undefined,
      run: RunResult | undefined,
    ): TaskOutcome => {
      const record: SandboxAttemptRecord = {
        taskId: task.id,
        repeat: context.repeat,
        seed: context.seed,
        outcome,
        predicate,
        run,
      };
      records.push(record);
      deps.onAttempt?.(record);
      return outcome;
    };

    const parsed = predicateFor(task, deps.goalPredicates);
    if (!parsed.ok) {
      return finish(
        errorOutcome(
          `goal could not be read: ${task.id}: ${parsed.reason}`,
          clock.now() - startedAt,
        ),
        undefined,
        undefined,
      );
    }
    const predicate = parsed.predicate;

    const goal = representativeGoal(predicate);
    if (goal === undefined) {
      return finish(
        errorOutcome(
          `task ${task.id} is not scorable in the sandbox tier: it needs positions or altitude, which the symbolic world does not model`,
          clock.now() - startedAt,
        ),
        predicate,
        undefined,
      );
    }

    const scenario = deps.scenario(task, context);
    if (scenario === undefined) {
      return finish(
        errorOutcome(
          `no sandbox scenario was provided for task ${task.id}; a Task carries no starting world, so one must be supplied`,
          clock.now() - startedAt,
        ),
        predicate,
        undefined,
      );
    }

    // The predicate, not the sandbox's own inventory test, decides the goal.
    // Item names are normalised on both sides inside `checkPredicateAgainstItems`,
    // because the suites are namespaced and the sandbox is not.
    const check = (world: SymbolicWorld): boolean => {
      const result = checkPredicateAgainstItems(
        predicate,
        world.inventory.toRecord(),
      );
      return result.checkable && result.met;
    };

    const symbolic = defineSymbolicTask({
      id: task.id,
      description: task.description,
      goal,
      impossible: task.impossible,
      stepBudget: task.budget.maxSteps,
      check,
      ...(scenario.startingInventory === undefined
        ? {}
        : { startingInventory: scenario.startingInventory }),
      ...(scenario.resources === undefined
        ? {}
        : { resources: scenario.resources }),
      ...(scenario.biome === undefined ? {} : { biome: scenario.biome }),
      ...(scenario.craftingTable === undefined
        ? {}
        : { craftingTable: scenario.craftingTable }),
      ...(scenario.furnace === undefined ? {} : { furnace: scenario.furnace }),
    });

    const policy =
      deps.policyFor === undefined
        ? (deps.policy as SandboxPolicy)
        : deps.policyFor(task, predicate);

    let run: RunResult;
    try {
      run = runTask(symbolic, policy, {
        stepBudget: task.budget.maxSteps,
        ...(deps.stopOnRefusal === undefined
          ? {}
          : { stopOnRefusal: deps.stopOnRefusal }),
        ...(scenario.recipes === undefined
          ? {}
          : { recipes: scenario.recipes }),
      });
    } catch (error) {
      return finish(
        errorOutcome(
          `sandbox executor threw: ${error instanceof Error ? error.message : String(error)}`,
          clock.now() - startedAt,
        ),
        predicate,
        undefined,
      );
    }

    const durationMs = clock.now() - startedAt;
    const steps = run.stepsUsed;
    const held = checkPredicateAgainstItems(
      predicate,
      run.world.inventory.toRecord(),
    );
    const state = held.checkable ? held.detail : held.reason;

    switch (run.outcome) {
      case 'goal-reached':
        return finish(
          { kind: 'success', steps, durationMs, detail: `goal met: ${state}` },
          predicate,
          run,
        );
      case 'budget-exhausted':
        return finish(
          {
            kind: 'timeout',
            steps,
            durationMs,
            detail: `step budget of ${task.budget.maxSteps} exhausted; ${state}`,
          },
          predicate,
          run,
        );
      case 'policy-error':
        return finish(
          errorOutcome(
            `policy threw: ${run.error?.message ?? 'unknown error'}`,
            durationMs,
          ),
          predicate,
          run,
        );
      case 'refused': {
        const reason = run.stopReason ?? '';
        const refused = declaresImpossible(reason);
        return finish(
          {
            kind: refused ? 'refused' : 'failure',
            steps,
            durationMs,
            detail: `${refused ? 'declared impossible' : 'stopped without meeting the goal'}: ${reason === '' ? 'no reason given' : reason}; ${state}`,
          },
          predicate,
          run,
        );
      }
    }
  };

  return Object.assign(executor, { records });
}
