import type { ZodType } from 'zod';
import type { ActuatorPort } from '../embodiment/port.js';
import type { WorldView } from '../perception/world-view.js';
import type { Clock } from '../runtime/clock.js';
import type { Logger } from '../runtime/logger.js';

/**
 * Why a skill did not succeed.
 *
 * Prior work collapses every failure into a boolean, which throws away the
 * only information that would tell an agent what to do next. A precondition
 * that was never met calls for a different response than a pathfinder that
 * gave up, and both differ from a timeout.
 */
export type FailureKind =
  /** Ran past its time budget. */
  | 'timeout'
  /** A stated precondition did not hold when checked. */
  | 'precondition'
  /** The target could not be reached. */
  | 'unreachable'
  /** Pre-empted by a reflex or an explicit cancellation. */
  | 'interrupted'
  /** The world moved: the target block or entity is gone. */
  | 'world-changed'
  /** Input failed schema validation. */
  | 'invalid-input'
  /** The perception profile forbade a read this skill required. */
  | 'not-permitted'
  /**
   * Refused by a rate limiter before the skill ran.
   *
   * Distinct from `timeout`, which means the work started and overran. Nothing
   * was attempted here, so the agent should wait rather than change its plan.
   */
  | 'rate-limited'
  /** Everything else. Should shrink over time. */
  | 'unknown';

/** Failures worth trying again without changing anything. */
export const RETRYABLE_FAILURES: readonly FailureKind[] = [
  'timeout',
  'unreachable',
  'world-changed',
  'rate-limited',
];

export function isRetryable(kind: FailureKind): boolean {
  return RETRYABLE_FAILURES.includes(kind);
}

export type SkillResult<T> =
  | { readonly ok: true; readonly value: T; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly message: string;
      readonly retryable: boolean;
      readonly durationMs: number;
    };

export function succeed<T>(value: T, durationMs: number): SkillResult<T> {
  return { ok: true, value, durationMs };
}

export function fail<T>(
  kind: FailureKind,
  message: string,
  durationMs: number,
): SkillResult<T> {
  return { ok: false, kind, message, retryable: isRetryable(kind), durationMs };
}

/** Outcome of a precondition check. */
export type PreconditionResult =
  | { readonly holds: true }
  | { readonly holds: false; readonly reason: string };

export const HOLDS: PreconditionResult = { holds: true };

export function fails(reason: string): PreconditionResult {
  return { holds: false, reason };
}

/**
 * What a skill is given when it runs.
 *
 * Note what is absent: there is no `SensorPort` and no mineflayer handle. A
 * skill can only learn about the world through `world`, which is gated and
 * counted. This is deliberate and load-bearing.
 */
export interface SkillContext {
  readonly world: WorldView;
  readonly act: ActuatorPort;
  readonly clock: Clock;
  readonly log: Logger;
  /** Aborted when a reflex pre-empts or the caller cancels. */
  readonly signal: AbortSignal;
}

export interface Skill<Input, Output> {
  readonly name: string;
  /** One line, shown to an agent choosing between skills. */
  readonly summary: string;
  /** Fuller description, including when *not* to use this skill. */
  readonly description: string;
  readonly input: ZodType<Input>;
  readonly output: ZodType<Output>;
  /** Time budget. Omitted means the registry default applies. */
  readonly timeoutMs?: number;
  /** Checked before `run`; a failure short-circuits without acting. */
  precondition?(ctx: SkillContext, input: Input): Promise<PreconditionResult>;
  run(ctx: SkillContext, input: Input): Promise<SkillResult<Output>>;
}

/** A skill whose input and output types have been erased for storage. */
export type AnySkill = Skill<never, unknown>;
