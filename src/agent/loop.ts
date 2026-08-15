import type { PerceptionReport } from '../perception/ledger.js';
import type { WorldView } from '../perception/world-view.js';
import type { Clock } from '../runtime/clock.js';
import type { Logger } from '../runtime/logger.js';
import { silentLogger } from '../runtime/logger.js';
import type { Goal } from './goal.js';
import { GoalStack } from './goal.js';
import { AgentMemory } from './memory.js';
import type { DigestOptions, ObservationDigest } from './observation-digest.js';
import { buildDigest } from './observation-digest.js';
import type {
  Decision,
  Policy,
  PolicyInput,
  SkillDescriptor,
  SkillInvoker,
  StepOutcome,
} from './policy.js';
import {
  describeDecision,
  describeOutcome,
  impliedBlockNames,
} from './policy.js';

/**
 * The reference loop: observe, decide, act, record, repeat.
 *
 * Three properties are non-negotiable, because without them a run is not a
 * measurement:
 *
 * - **A step budget.** An agent that can loop forever cannot be compared with
 *   one that cannot, and an unbounded run is an unbounded bill.
 * - **An abort signal.** Something outside the loop — a reflex, a supervisor, a
 *   human — must be able to stop it between steps.
 * - **A trace.** Every decision and every outcome is recorded. A result you
 *   cannot reconstruct is an anecdote, and reconstructing it after the fact
 *   from logs is how prior work ends up unable to say what its agent knew.
 *
 * The loop holds a `WorldView` and a `SkillInvoker` and nothing else. There is
 * no bot handle here and no sensor port, so the perception ledger attached to a
 * run says something true.
 */

export type StopReason = 'done' | 'budget' | 'aborted' | 'error' | 'no-goal';

export interface TraceStep {
  readonly step: number;
  readonly startedAt: number;
  readonly endedAt: number;
  /** The rendered observation the decision was made from. */
  readonly digest: string;
  readonly goal: string | undefined;
  readonly decision: Decision;
  readonly outcome: StepOutcome;
  /** Wall-clock spent deciding. */
  readonly decideMs: number;
}

export interface RunTrace {
  readonly steps: readonly TraceStep[];
  readonly stoppedBecause: StopReason;
  readonly reason: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** How this run came by its knowledge. Reported next to every result. */
  readonly perception: PerceptionReport;
  readonly goals: readonly Goal[];
}

export interface AgentLoopOptions {
  readonly world: WorldView;
  readonly invoker: SkillInvoker;
  readonly policy: Policy;
  readonly clock: Clock;
  readonly memory?: AgentMemory;
  readonly goals?: GoalStack;
  /** The catalogue shown to the policy. Empty means "not advertised". */
  readonly skills?: readonly SkillDescriptor[];
  readonly log?: Logger;
  /** Hard cap on steps. Default 32. */
  readonly maxSteps?: number;
  readonly digest?: DigestOptions;
  /** Called for a `speak` decision. Without it, speech is recorded only. */
  readonly speak?: (text: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** Put the full digest into memory each step. Default false: it is large. */
  readonly recordDigestInMemory?: boolean;
  /** Called after every step, for live inspection of a run. */
  readonly onStep?: (step: TraceStep) => void;
}

export class AgentLoop {
  readonly #o: AgentLoopOptions;
  readonly #log: Logger;
  readonly memory: AgentMemory;
  readonly goals: GoalStack;

  #steps: TraceStep[] = [];

  constructor(options: AgentLoopOptions) {
    this.#o = options;
    this.#log = options.log ?? silentLogger;
    this.memory =
      options.memory ?? new AgentMemory({ clock: options.clock });
    this.goals = options.goals ?? new GoalStack({ clock: options.clock });
  }

  /** The trace so far, including a run still in progress. */
  get steps(): readonly TraceStep[] {
    return this.#steps;
  }

  /**
   * Digest options for the goal currently on top of the stack.
   *
   * `WorldView.findBlocks` has no "everything" mode by design, so a digest
   * only lists blocks it was told to look for. Configured names are therefore
   * merged with names implied by the active goal: without that, an agent
   * pursuing "gather 3 oak_log" would be handed a digest containing no logs
   * and would conclude there were none, which is a fabricated observation
   * rather than an honest absence.
   */
  #digestOptions(goal: Goal | undefined): DigestOptions {
    const configured = this.#o.digest ?? {};
    const implied = goal === undefined ? undefined : impliedBlockNames(goal);
    if (implied === undefined || implied.length === 0) return configured;
    const names = new Set([...(configured.blockNames ?? []), ...implied]);
    return { ...configured, blockNames: [...names] };
  }

  observe(): ObservationDigest {
    return buildDigest(
      this.#o.world,
      this.#o.clock.now(),
      this.#digestOptions(this.goals.current()),
    );
  }

  async run(): Promise<RunTrace> {
    const clock = this.#o.clock;
    const startedAt = clock.now();
    const maxSteps = this.#o.maxSteps ?? 32;
    const signal = this.#o.signal;
    this.#steps = [];

    let stoppedBecause: StopReason = 'budget';
    let reason = `step budget of ${maxSteps} exhausted`;
    let lastOutcome: StepOutcome | undefined;

    for (let step = 0; step < maxSteps; step++) {
      if (signal !== undefined && isAborted(signal)) {
        stoppedBecause = 'aborted';
        reason = abortReason(signal);
        break;
      }

      const stepStarted = clock.now();
      const digest = buildDigest(
        this.#o.world,
        stepStarted,
        this.#digestOptions(this.goals.current()),
      );
      if (this.#o.recordDigestInMemory === true) {
        this.memory.append('observation', digest.text);
      }

      const goal = this.goals.current();
      const input: PolicyInput = {
        digest,
        goal,
        goals: this.goals.stack(),
        memory: this.memory.snapshot(),
        skills: this.#o.skills ?? [],
        step,
        stepBudget: maxSteps,
        lastOutcome,
        signal: signal ?? neverAborted(),
      };

      let decision: Decision;
      let outcome: StepOutcome;
      const decideStart = clock.now();
      try {
        decision = await this.#o.policy.decide(input);
      } catch (error) {
        // A policy that throws has ended the episode, but the run is still a
        // record: note it as a step so the trace explains the stop.
        decision = { kind: 'done', reason: 'policy threw' };
        outcome = { kind: 'policy-error', message: errorMessage(error) };
        this.#record(step, stepStarted, digest, goal, decision, outcome, clock.now() - decideStart);
        stoppedBecause = 'error';
        reason = outcome.message;
        break;
      }
      const decideMs = clock.now() - decideStart;

      this.memory.append('action', describeDecision(decision));
      this.#log.debug('decided', { step, decision: describeDecision(decision) });

      // The signal may have fired while the policy was thinking, which for an
      // LLM policy is most of the elapsed time. Do not act on a stale decision.
      if (signal !== undefined && isAborted(signal)) {
        outcome = { kind: 'aborted', reason: abortReason(signal) };
        this.#record(step, stepStarted, digest, goal, decision, outcome, decideMs);
        stoppedBecause = 'aborted';
        reason = outcome.reason;
        break;
      }

      let stop: { readonly why: StopReason; readonly reason: string } | undefined;

      switch (decision.kind) {
        case 'done': {
          outcome = { kind: 'done', reason: decision.reason };
          stop = { why: 'done', reason: decision.reason };
          break;
        }
        case 'speak': {
          try {
            await this.#o.speak?.(decision.text);
            outcome = { kind: 'spoke', text: decision.text };
          } catch (error) {
            outcome = {
              kind: 'skill-failed',
              name: 'speak',
              failure: 'unknown',
              message: errorMessage(error),
              retryable: false,
              durationMs: 0,
            };
          }
          break;
        }
        case 'skill': {
          outcome = await this.#invoke(decision, signal);
          break;
        }
      }

      this.memory.append('outcome', describeOutcome(outcome));
      this.#record(step, stepStarted, digest, goal, decision, outcome, decideMs);
      lastOutcome = outcome;

      if (stop) {
        stoppedBecause = stop.why;
        reason = stop.reason;
        break;
      }
    }

    const endedAt = clock.now();
    this.#log.info('run finished', {
      steps: this.#steps.length,
      stoppedBecause,
      reason,
    });

    return {
      steps: this.#steps,
      stoppedBecause,
      reason,
      startedAt,
      endedAt,
      perception: this.#o.world.report(),
      goals: [...this.goals.stack(), ...this.goals.history()],
    };
  }

  async #invoke(
    decision: Decision & { readonly kind: 'skill' },
    signal: AbortSignal | undefined,
  ): Promise<StepOutcome> {
    try {
      const result = await this.#o.invoker.invoke(
        decision.name,
        decision.input,
        signal === undefined ? {} : { signal },
      );
      return result.ok
        ? {
            kind: 'skill-ok',
            name: decision.name,
            value: result.value,
            durationMs: result.durationMs,
          }
        : {
            kind: 'skill-failed',
            name: decision.name,
            failure: result.kind,
            message: result.message,
            retryable: result.retryable,
            durationMs: result.durationMs,
          };
    } catch (error) {
      // An invoker that throws is a broken surface, not a failed skill. It is
      // still recorded as a failure so the run continues to be inspectable.
      return {
        kind: 'skill-failed',
        name: decision.name,
        failure: 'unknown',
        message: `invoker threw: ${errorMessage(error)}`,
        retryable: false,
        durationMs: 0,
      };
    }
  }

  #record(
    step: number,
    startedAt: number,
    digest: ObservationDigest,
    goal: Goal | undefined,
    decision: Decision,
    outcome: StepOutcome,
    decideMs: number,
  ): void {
    const trace: TraceStep = {
      step,
      startedAt,
      endedAt: this.#o.clock.now(),
      digest: digest.text,
      goal: goal?.description,
      decision,
      outcome,
      decideMs,
    };
    this.#steps.push(trace);
    this.#o.onStep?.(trace);
  }
}

/** A human-readable rendering of a finished run. */
export function formatTrace(trace: RunTrace): string {
  const lines = [
    `run: ${trace.steps.length} steps, stopped (${trace.stoppedBecause}): ${trace.reason}`,
    `perception: ${trace.perception.total} reads, ${trace.perception.privileged} privileged, fair play ${trace.perception.fairPlay ? 'yes' : 'no'}`,
  ];
  for (const s of trace.steps) {
    lines.push(
      `  ${s.step}. ${s.goal === undefined ? '(no goal)' : s.goal} :: ${describeDecision(s.decision)} -> ${describeOutcome(s.outcome)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Written as a call rather than inline so narrowing cannot convince the
 * compiler the flag is still what it was before we awaited the policy.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  if (r === undefined) return 'aborted';
  return r instanceof Error ? r.message : String(r);
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
