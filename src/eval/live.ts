/**
 * The live tier: driving a real agent through a task against a real world.
 *
 * `runSuite` takes an injected `TaskExecutor` and, until this module existed,
 * every implementation of that interface was a test fake. The harness could
 * score, but it had nothing to score. This is the missing half: push the task's
 * goal onto an agent, run its loop under the task's budgets, check the goal
 * through the same perception gate the agent used, and map what happened onto
 * a `TaskOutcome`.
 *
 * ## What this module cannot do, and does not pretend to do
 *
 * A benchmark attempt properly begins from a known world: a fresh chunk, a
 * known biome, an empty inventory, a fixed seed. None of that is reachable from
 * inside this process. A `WorldView` is read-only by construction, and the
 * skill surface can dig and craft but cannot teleport a bot, roll a world back,
 * or empty an inventory. So there is no reset here, and nothing here fabricates
 * one.
 *
 * Instead the reset is a capability the caller must provide: `deps.prepare`. If
 * it is absent the executor still runs, but every attempt records
 * `preparedBy: 'nothing'` and says so in its detail text, because an attempt
 * that inherited the previous attempt's inventory is a different measurement
 * from one that started clean and the score must not silently conflate them.
 *
 * Likewise, this module does not spawn a session. `deps.session` is supplied by
 * the caller, because connecting to a server is exactly the part that cannot be
 * done offline, and a module that quietly connected to `localhost` in a test
 * run would be worse than one that refuses.
 */

import type { RunTrace, TraceStep } from '../agent/loop.js';
import { AgentLoop } from '../agent/loop.js';
import type { Policy, SkillDescriptor, SkillInvoker } from '../agent/policy.js';
import type { PerceptionReport } from '../perception/ledger.js';
import type { WorldView } from '../perception/world-view.js';
import type { Clock } from '../runtime/clock.js';
import type { Logger } from '../runtime/logger.js';
import type { GoalCheck, GoalPredicateOverrides } from './goal-check.js';
import { checkTaskGoal } from './goal-check.js';
import type { AttemptContext, TaskExecutor } from './runner.js';
import type { TaskOutcome } from './scoring.js';
import type { Task } from './task.js';

/**
 * The part of a live session this executor needs.
 *
 * Declared structurally here rather than imported from `src/runtime/session.ts`
 * on purpose. The eval harness must stay usable against any implementation of
 * the substrate, including one that is not this repository's, and a hard import
 * of a concrete session type would make the harness a client of a particular
 * runtime. Anything with these four members qualifies, which a full `Session`
 * satisfies structurally without knowing this interface exists.
 */
export interface LiveSession {
  /** The gated, counted read surface. The only way the goal gets checked. */
  readonly world: WorldView;
  /** How the agent acts. An in-process runner or an MCP client, indifferently. */
  readonly invoker: SkillInvoker;
  /** Time source. Never `Date.now()` directly, so a run can be replayed. */
  readonly clock: Clock;
  /** The catalogue advertised to the policy. Absent means "not advertised". */
  readonly skills?: readonly SkillDescriptor[];
  /** Released after the attempt when the executor owns the session. */
  close?(): void | Promise<void>;
}

/** What was recorded about one live attempt, beyond what `TaskOutcome` holds. */
export interface LiveAttemptRecord {
  readonly taskId: string;
  readonly repeat: number;
  readonly seed: number;
  readonly outcome: TaskOutcome;
  /**
   * How this attempt came by its knowledge, agent and goal check together. A
   * score without this beside it is not a result: it does not say whether the
   * agent earned it by looking or by being told.
   */
  readonly perception: PerceptionReport;
  /** Whether the world was reset before the attempt, and by what. */
  readonly preparedBy: 'caller' | 'nothing';
  readonly goal: GoalCheck;
  readonly trace: RunTrace | undefined;
}

/** A `TaskExecutor` that also keeps what a `TaskOutcome` has no room for. */
export type RecordingExecutor = TaskExecutor & {
  readonly records: readonly LiveAttemptRecord[];
};

export interface LiveExecutorDeps {
  /** The agent under test. One policy, or one per task. */
  readonly policy: Policy | ((task: Task) => Policy);
  /** Supplies a session for an attempt. The caller owns connecting. */
  readonly session: (
    task: Task,
    context: AttemptContext,
  ) => LiveSession | Promise<LiveSession>;
  /**
   * Resets the world to the task's starting conditions.
   *
   * The honest name for the thing this module cannot do itself. Provide it and
   * attempts are comparable; omit it and they are a sequence, which the record
   * says out loud.
   */
  readonly prepare?: (
    session: LiveSession,
    task: Task,
    context: AttemptContext,
  ) => void | Promise<void>;
  /** Closes the session after each attempt. Default true when `close` exists. */
  readonly closeSession?: boolean;
  /** Predicates for goals the parser cannot read. Keyed by task id. */
  readonly goalPredicates?: GoalPredicateOverrides;
  /**
   * Whether a deliberate stop was a considered refusal. Overrides the default
   * reading of the stop reason; see `declaresImpossible`.
   */
  readonly isRefusal?: (trace: RunTrace, task: Task) => boolean;
  /**
   * Run under a profile other than the task's. Off by default: a result earned
   * under the wrong perception profile is a different result, and returning it
   * as if it were the task's would quietly corrupt a suite score.
   */
  readonly allowProfileMismatch?: boolean;
  readonly log?: Logger;
  readonly onAttempt?: (record: LiveAttemptRecord) => void;
}

/* ------------------------------------------------------------------ */
/* Refusal                                                             */
/* ------------------------------------------------------------------ */

/**
 * Vocabulary that reads as "this goal cannot be met", not "I gave up".
 *
 * The refusal suite turns entirely on this distinction: an agent that stops
 * because bedrock has no drop is doing the correct thing, and an agent that
 * stops because it got bored is not, and both arrive here as a `done` decision
 * with a sentence attached. The list is deliberately about impossibility rather
 * than about difficulty, so "too hard" and "gave up" do not creep in.
 *
 * A policy that wants to be unambiguous can simply begin its reason with
 * `impossible:`, which always counts.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^\s*impossible\s*:/i,
  /\bimpossible\b/i,
  /\bunsatisfiable\b/i,
  /\bunobtainable\b/i,
  /\bunreachable goal\b/i,
  /\bno such (?:item|recipe|block|thing)\b/i,
  /\bunknown-recipe\b/i,
  /\bunknown-resource\b/i,
  /\bdoes not exist\b/i,
  /\bcannot be (?:done|made|crafted|obtained|reached|achieved|completed)\b/i,
  /\bcannot obtain\b/i,
  /\bno recipe\b/i,
  /\bnot possible\b/i,
  /\brefus(?:e|ed|ing)\b/i,
];

/** True when a stated reason asserts the goal is unsatisfiable. */
export function declaresImpossible(reason: string): boolean {
  return REFUSAL_PATTERNS.some((p) => p.test(reason));
}

/**
 * Whether a finished run was a considered refusal.
 *
 * Reads the stop reason first, then anything the agent said on its final step.
 * An agent that announces "there is no obsidian sword recipe" and then stops
 * has refused, even if its `done` reason was terse.
 */
export function traceDeclaresImpossible(trace: RunTrace): boolean {
  if (declaresImpossible(trace.reason)) return true;
  const last = trace.steps[trace.steps.length - 1];
  return last !== undefined && spokeRefusal(last);
}

function spokeRefusal(step: TraceStep): boolean {
  if (step.decision.kind === 'speak') {
    return declaresImpossible(step.decision.text);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The executor                                                        */
/* ------------------------------------------------------------------ */

function errorOutcome(
  steps: number,
  durationMs: number,
  detail: string,
): TaskOutcome {
  return { kind: 'error', steps, durationMs, detail };
}

export function createLiveExecutor(deps: LiveExecutorDeps): RecordingExecutor {
  const records: LiveAttemptRecord[] = [];

  const executor = async (
    task: Task,
    context: AttemptContext,
  ): Promise<TaskOutcome> => {
    const session = await deps.session(task, context);
    const clock = session.clock;
    const startedAt = clock.now();
    let trace: RunTrace | undefined;
    let preparedBy: 'caller' | 'nothing' = 'nothing';

    const finish = (outcome: TaskOutcome, goal: GoalCheck): TaskOutcome => {
      const record: LiveAttemptRecord = {
        taskId: task.id,
        repeat: context.repeat,
        seed: context.seed,
        outcome,
        perception: session.world.report(),
        preparedBy,
        goal,
        trace,
      };
      records.push(record);
      deps.onAttempt?.(record);
      return outcome;
    };

    try {
      if (
        deps.allowProfileMismatch !== true &&
        session.world.profile.name !== task.profile
      ) {
        // Not a failure of the agent, so not scored as one.
        return finish(
          errorOutcome(
            0,
            clock.now() - startedAt,
            `task ${task.id} requires perception profile "${task.profile}" but the session runs "${session.world.profile.name}"`,
          ),
          {
            checkable: false,
            reason: 'not checked: profile mismatch',
          },
        );
      }

      if (deps.prepare !== undefined) {
        await deps.prepare(session, task, context);
        preparedBy = 'caller';
      }

      const policy =
        typeof deps.policy === 'function' ? deps.policy(task) : deps.policy;

      const loop = new AgentLoop({
        world: session.world,
        invoker: session.invoker,
        policy,
        clock,
        maxSteps: task.budget.maxSteps,
        signal: context.signal,
        ...(session.skills === undefined ? {} : { skills: session.skills }),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });

      // The agent is told what it is being measured on, in the suite's own
      // words. Nothing here paraphrases the goal into something easier.
      loop.goals.push(`${task.title}: ${task.goal}`, { tags: ['eval', task.id] });

      trace = await loop.run();
      const steps = trace.steps.length;
      const durationMs = clock.now() - startedAt;
      const goal = checkTaskGoal(task, session.world, deps.goalPredicates);

      if (!goal.checkable) {
        return finish(
          errorOutcome(
            steps,
            durationMs,
            `goal could not be checked: ${goal.reason}`,
          ),
          goal,
        );
      }

      const note = goal.caveat === undefined ? '' : ` (${goal.caveat})`;
      const preparation =
        preparedBy === 'caller'
          ? ''
          : '; no world reset was performed: the attempt inherited whatever state preceded it';

      if (goal.met) {
        return finish(
          {
            kind: 'success',
            steps,
            durationMs,
            detail: `goal met: ${goal.detail}${note}${preparation}`,
          },
          goal,
        );
      }

      switch (trace.stoppedBecause) {
        case 'budget':
        case 'aborted':
          return finish(
            {
              kind: 'timeout',
              steps,
              durationMs,
              detail: `${trace.reason}; ${goal.detail}${preparation}`,
            },
            goal,
          );
        case 'error':
          return finish(
            errorOutcome(steps, durationMs, `agent loop failed: ${trace.reason}`),
            goal,
          );
        case 'done':
        case 'no-goal': {
          // The distinction the refusal suite exists to measure: an agent that
          // stopped because the goal cannot be met, versus one that stopped
          // having failed to meet a goal that can.
          const refused =
            deps.isRefusal === undefined
              ? traceDeclaresImpossible(trace)
              : deps.isRefusal(trace, task);
          return finish(
            {
              kind: refused ? 'refused' : 'failure',
              steps,
              durationMs,
              detail: `${refused ? 'declared impossible' : 'stopped without meeting the goal'}: ${trace.reason}; ${goal.detail}${preparation}`,
            },
            goal,
          );
        }
      }
    } catch (error) {
      // A throw is the harness or the substrate breaking, never a measurement
      // of ability. The runner would catch this too; catching it here means the
      // attempt still gets a record with its perception report attached.
      return finish(
        errorOutcome(
          trace?.steps.length ?? 0,
          clock.now() - startedAt,
          `live executor threw: ${message(error)}`,
        ),
        { checkable: false, reason: 'not checked: the attempt threw' },
      );
    } finally {
      const shouldClose = deps.closeSession ?? true;
      if (shouldClose && session.close !== undefined) await session.close();
    }
  };

  // The same array throughout, so the property stays live as attempts land.
  return Object.assign(executor, { records });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
