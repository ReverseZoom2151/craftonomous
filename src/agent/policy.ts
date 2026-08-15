import type { FailureKind } from '../skills/types.js';
import type { Goal } from './goal.js';
import type { MemorySnapshot } from './memory.js';
import type { ObservationDigest } from './observation-digest.js';

/**
 * The decision interface.
 *
 * This is the seam the whole project is built around: everything below it is
 * substrate, everything above it is a brain, and the brain can be an LLM, a
 * hand-written rule set, or a fixed script without anything below noticing.
 *
 * Note what a `Policy` is *not* given: no `WorldView` beyond the digest it is
 * handed, no `SensorPort`, no bot. It reads what it was shown and returns an
 * intent. Acting is somebody else's job.
 */

export type Decision =
  | { readonly kind: 'skill'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'speak'; readonly text: string }
  | { readonly kind: 'done'; readonly reason: string };

/** What an agent is told about a skill it may invoke. */
export interface SkillDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  /** JSON Schema for the input, when the surface can provide one. */
  readonly inputSchema?: unknown;
}

/**
 * The result of invoking a skill, structurally identical to `SkillResult` but
 * declared here so this module depends on no runner implementation.
 */
export type InvocationResult =
  | { readonly ok: true; readonly value: unknown; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly message: string;
      readonly retryable: boolean;
      readonly durationMs: number;
    };

/**
 * How the agent acts. Deliberately narrow: a name, a payload, a signal.
 *
 * The reference agent is a client of the same surface as everyone else, so this
 * is satisfied equally by an in-process skill runner or by an MCP client
 * calling tools over a transport. Neither is imported here.
 */
export interface SkillInvoker {
  invoke(
    name: string,
    input: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InvocationResult>;
}

/** What became of a decision. Recorded for every step of a run. */
export type StepOutcome =
  | {
      readonly kind: 'skill-ok';
      readonly name: string;
      readonly value: unknown;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'skill-failed';
      readonly name: string;
      readonly failure: FailureKind;
      readonly message: string;
      readonly retryable: boolean;
      readonly durationMs: number;
    }
  | { readonly kind: 'spoke'; readonly text: string }
  | { readonly kind: 'done'; readonly reason: string }
  | { readonly kind: 'policy-error'; readonly message: string }
  | { readonly kind: 'aborted'; readonly reason: string };

export interface PolicyInput {
  /** Structured and rendered observation, provenance intact. */
  readonly digest: ObservationDigest;
  readonly goal: Goal | undefined;
  /** The full stack, bottom-first. */
  readonly goals: readonly Goal[];
  readonly memory: MemorySnapshot;
  readonly skills: readonly SkillDescriptor[];
  /** Zero-based step index within the run. */
  readonly step: number;
  readonly stepBudget: number;
  readonly lastOutcome: StepOutcome | undefined;
  readonly signal: AbortSignal;
}

export interface Policy {
  decide(input: PolicyInput): Promise<Decision>;
}

export function skillDecision(name: string, input: unknown = {}): Decision {
  return { kind: 'skill', name, input };
}

export function doneDecision(reason: string): Decision {
  return { kind: 'done', reason };
}

export function describeDecision(decision: Decision): string {
  switch (decision.kind) {
    case 'skill':
      return `skill ${decision.name}(${safeJson(decision.input)})`;
    case 'speak':
      return `speak "${decision.text}"`;
    case 'done':
      return `done: ${decision.reason}`;
  }
}

export function describeOutcome(outcome: StepOutcome): string {
  switch (outcome.kind) {
    case 'skill-ok':
      return `${outcome.name} ok in ${outcome.durationMs}ms -> ${safeJson(outcome.value)}`;
    case 'skill-failed':
      return `${outcome.name} failed (${outcome.failure}${outcome.retryable ? ', retryable' : ''}): ${outcome.message}`;
    case 'spoke':
      return `said "${outcome.text}"`;
    case 'done':
      return `stopped: ${outcome.reason}`;
    case 'policy-error':
      return `policy error: ${outcome.message}`;
    case 'aborted':
      return `aborted: ${outcome.reason}`;
  }
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  } catch {
    return '<unserialisable>';
  }
}

/* ------------------------------------------------------------------ */
/* ScriptedPolicy                                                      */
/* ------------------------------------------------------------------ */

/**
 * Plays a fixed sequence of decisions.
 *
 * Two jobs: it makes the loop testable with no model and no server, and it is
 * the baseline an evaluated agent has to beat. A scripted run that solves a
 * task tells you the task is solvable by the skill set alone, which is
 * precisely the number a headline result should be read against.
 */
export class ScriptedPolicy implements Policy {
  readonly #script: readonly Decision[];
  readonly #exhausted: Decision;
  #cursor = 0;

  constructor(
    script: readonly Decision[],
    options: { readonly onExhausted?: Decision } = {},
  ) {
    this.#script = script;
    this.#exhausted =
      options.onExhausted ?? doneDecision('script exhausted');
  }

  get cursor(): number {
    return this.#cursor;
  }

  reset(): void {
    this.#cursor = 0;
  }

  decide(_input: PolicyInput): Promise<Decision> {
    const next = this.#script[this.#cursor];
    if (next === undefined) return Promise.resolve(this.#exhausted);
    this.#cursor += 1;
    return Promise.resolve(next);
  }
}

/* ------------------------------------------------------------------ */
/* RulePolicy                                                          */
/* ------------------------------------------------------------------ */

/** Skill names this policy will reach for. Overridable per deployment. */
export interface RuleSkillNames {
  readonly eat: string;
  readonly collect: string;
  readonly explore: string;
  readonly flee: string;
}

export const DEFAULT_RULE_SKILLS: RuleSkillNames = {
  eat: 'eat',
  collect: 'collect_block',
  explore: 'explore',
  flee: 'flee',
};

export const DEFAULT_FOODS: readonly string[] = [
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_cod',
  'cooked_salmon',
  'baked_potato',
  'golden_carrot',
  'carrot',
  'apple',
  'melon_slice',
  'sweet_berries',
];

export interface RulePolicyOptions {
  readonly skills?: Partial<RuleSkillNames>;
  readonly foods?: readonly string[];
  /** Eat at or below this food level. Default 6. */
  readonly hungerThreshold?: number;
  /** Flee at or below this health, with a hostile in view. Default 6. */
  readonly panicHealth?: number;
  /** Hostiles nearer than this count as a threat. Default 8 blocks. */
  readonly threatRange?: number;
}

/** `gather 5 oak_log`, `collect iron_ore`, `mine 3 coal_ore`. */
const GATHER = /\b(?:gather|collect|mine|get|obtain)\s+(?:(\d+)\s+)?([a-z0-9_]+)/i;

export interface GatherGoal {
  readonly item: string;
  readonly count: number;
}

export function parseGatherGoal(description: string): GatherGoal | undefined {
  const m = GATHER.exec(description);
  const item = m?.[2];
  if (item === undefined) return undefined;
  const raw = m?.[1];
  const count = raw === undefined ? 1 : Number.parseInt(raw, 10);
  return { item: item.toLowerCase(), count: Number.isFinite(count) && count > 0 ? count : 1 };
}

/**
 * A small deterministic policy: survive, then pursue a gather goal.
 *
 * It exists to prove the loop closes without a model in it. It is not clever
 * and is not meant to be; when an LLM policy fails to beat this on a task, the
 * interesting question is about the task, not the model.
 */
export class RulePolicy implements Policy {
  readonly #skills: RuleSkillNames;
  readonly #foods: ReadonlySet<string>;
  readonly #hungerThreshold: number;
  readonly #panicHealth: number;
  readonly #threatRange: number;

  constructor(options: RulePolicyOptions = {}) {
    this.#skills = { ...DEFAULT_RULE_SKILLS, ...options.skills };
    this.#foods = new Set(options.foods ?? DEFAULT_FOODS);
    this.#hungerThreshold = options.hungerThreshold ?? 6;
    this.#panicHealth = options.panicHealth ?? 6;
    this.#threatRange = options.threatRange ?? 8;
  }

  decide(input: PolicyInput): Promise<Decision> {
    return Promise.resolve(this.#decide(input));
  }

  /** An empty catalogue means "unknown", not "nothing"; assume available. */
  #available(input: PolicyInput, name: string): boolean {
    return (
      input.skills.length === 0 || input.skills.some((s) => s.name === name)
    );
  }

  /** Do not immediately re-issue a skill that just failed unrecoverably. */
  #justFailed(input: PolicyInput, name: string): boolean {
    const last = input.lastOutcome;
    return (
      last !== undefined &&
      last.kind === 'skill-failed' &&
      last.name === name &&
      !last.retryable
    );
  }

  #decide(input: PolicyInput): Decision {
    const body = input.digest.body.value;
    const inventory = input.digest.inventory.value;

    // 1. Survival first. A dead agent achieves no goals, and this is the kind
    //    of reaction that should never wait on a model round-trip.
    const threat = input.digest.entities.find(
      (e) =>
        e.value.hostile === true &&
        distance(e.value.position, body.position) <= this.#threatRange,
    );
    if (
      threat &&
      body.health <= this.#panicHealth &&
      this.#available(input, this.#skills.flee) &&
      !this.#justFailed(input, this.#skills.flee)
    ) {
      return skillDecision(this.#skills.flee, {
        from: threat.value.position,
        entityId: threat.value.id,
      });
    }

    if (
      body.food <= this.#hungerThreshold &&
      this.#available(input, this.#skills.eat) &&
      !this.#justFailed(input, this.#skills.eat)
    ) {
      const food = inventory.find((s) => this.#foods.has(s.name));
      if (food) return skillDecision(this.#skills.eat, { item: food.name });
    }

    // 2. Pursue the goal.
    const goal = input.goal;
    if (goal === undefined) return doneDecision('no active goal');

    const gather = parseGatherGoal(goal.description);
    if (gather === undefined) {
      return doneDecision(
        `no rule covers the goal "${goal.description}"; a rule policy cannot pursue it`,
      );
    }

    const held = countItem(inventory, gather.item);
    if (held >= gather.count) {
      return doneDecision(
        `goal satisfied: holding ${held} ${gather.item} (needed ${gather.count})`,
      );
    }

    // Prefer a block the agent can currently see. A remembered block is worth
    // trying, but only after everything present has been used, and never
    // treated as certain: the skill will report `world-changed` if it is gone.
    const target =
      input.digest.blocks.find(
        (b) => b.value.name === gather.item && b.provenance !== 'memory',
      ) ?? input.digest.blocks.find((b) => b.value.name === gather.item);

    if (target && this.#available(input, this.#skills.collect)) {
      return skillDecision(this.#skills.collect, {
        name: gather.item,
        position: target.value.position,
        count: gather.count - held,
        remembered: target.provenance === 'memory',
      });
    }

    if (
      this.#available(input, this.#skills.explore) &&
      !this.#justFailed(input, this.#skills.explore)
    ) {
      return skillDecision(this.#skills.explore, { looking_for: gather.item });
    }

    return doneDecision(
      `no ${gather.item} is known and no way to look for more`,
    );
  }
}

function countItem(
  inventory: readonly { readonly name: string; readonly count: number }[],
  item: string,
): number {
  let n = 0;
  for (const s of inventory) if (s.name === item) n += s.count;
  return n;
}

function distance(
  a: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly x: number; readonly y: number; readonly z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
