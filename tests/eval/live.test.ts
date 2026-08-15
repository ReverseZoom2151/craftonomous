import { describe, expect, it } from 'vitest';

import type { Decision, Policy, PolicyInput } from '../../src/agent/policy.js';
import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import type { HeardSound } from '../../src/perception/adapter.js';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import type { Testimony } from '../../src/perception/testimony.js';
import type { PerceptionReport } from '../../src/perception/ledger.js';
import { FAIR_PLAY, XRAY } from '../../src/perception/profile.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import type { WorldView } from '../../src/perception/world-view.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { checkPredicate, parseGoal } from '../../src/eval/goal-check.js';
import { createLiveExecutor, declaresImpossible } from '../../src/eval/live.js';
import type { LiveSession } from '../../src/eval/live.js';
import type { AttemptContext } from '../../src/eval/runner.js';
import { defineTask } from '../../src/eval/task.js';
import type { Task } from '../../src/eval/task.js';

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

const BODY: BodyState = {
  position: { x: 0, y: 64, z: 0 },
  eyePosition: { x: 0, y: 65, z: 0 },
  health: 20,
  food: 20,
  oxygen: 20,
  onGround: true,
  inWater: false,
  inLava: false,
  isBurning: false,
  yaw: 0,
  pitch: 0,
  dimension: 'overworld',
};

interface FakeWorldSpec {
  readonly inventory?: readonly ItemStack[];
  readonly blocks?: readonly BlockInfo[];
  readonly body?: BodyState;
  readonly profile?: PerceptionProfile;
  /**
   * State the world knows but does not expose through `WorldView`. Present so a
   * test can prove the goal checker never reaches past the gate for it.
   */
  readonly hidden?: readonly ItemStack[];
}

class FakeWorld implements WorldView {
  readonly profile: PerceptionProfile;
  readonly reads: string[] = [];
  readonly hidden: readonly ItemStack[];

  #inventory: ItemStack[];
  #blocks: BlockInfo[];
  #body: BodyState;
  readonly #ledger = new PerceptionLedger();

  constructor(spec: FakeWorldSpec = {}) {
    this.profile = spec.profile ?? FAIR_PLAY;
    this.#inventory = [...(spec.inventory ?? [])];
    this.#blocks = [...(spec.blocks ?? [])];
    this.#body = spec.body ?? BODY;
    this.hidden = spec.hidden ?? [];
  }

  give(name: string, count: number): void {
    this.#inventory = [...this.#inventory, { name, count }];
  }

  place(block: BlockInfo): void {
    this.#blocks = [...this.#blocks, block];
  }

  moveTo(position: Vec3Like): void {
    this.#body = { ...this.#body, position };
  }

  #observe<T>(value: T, provenance: 'proprioception' | 'sight'): Observed<T> {
    this.#ledger.record(provenance);
    return { value, provenance, sensedAt: 0 };
  }

  body(): Observed<BodyState> {
    this.reads.push('body');
    return this.#observe(this.#body, 'proprioception');
  }

  inventory(): Observed<readonly ItemStack[]> {
    this.reads.push('inventory');
    return this.#observe(this.#inventory, 'proprioception');
  }

  blockAt(position: Vec3Like): Observed<BlockInfo> | undefined {
    this.reads.push('blockAt');
    const found = this.#blocks.find(
      (b) =>
        b.position.x === position.x &&
        b.position.y === position.y &&
        b.position.z === position.z,
    );
    return found === undefined ? undefined : this.#observe(found, 'sight');
  }

  nearbyEntities(): readonly Observed<EntityInfo>[] {
    this.reads.push('nearbyEntities');
    return [];
  }

  sounds(): readonly Observed<HeardSound>[] {
    this.reads.push('sounds');
    return [];
  }

  testimony(): readonly Observed<Testimony>[] {
    this.reads.push('testimony');
    return [];
  }

  checkPositionClaim(claim: Testimony): Testimony {
    this.reads.push('checkPositionClaim');
    return claim;
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit?: number;
  }): readonly Observed<BlockInfo>[] {
    this.reads.push('findBlocks');
    const wanted = new Set(options.names);
    return this.#blocks
      .filter((b) => wanted.has(b.name))
      .map((b) => this.#observe(b, 'sight'));
  }

  openContainer(): Observed<ContainerView> | undefined {
    this.reads.push('openContainer');
    return undefined;
  }

  recollections(): readonly Observed<BlockInfo>[] {
    this.reads.push('recollections');
    return [];
  }

  report(): PerceptionReport {
    return this.#ledger.report();
  }
}

/** Plays a fixed list of decisions, then repeats the last one forever. */
class ScriptPolicy implements Policy {
  #cursor = 0;

  constructor(
    private readonly script: readonly Decision[],
    private readonly onStep?: (step: number) => void,
  ) {}

  decide(input: PolicyInput): Promise<Decision> {
    this.onStep?.(input.step);
    const next =
      this.script[Math.min(this.#cursor, this.script.length - 1)] ??
      ({ kind: 'done', reason: 'empty script' } as Decision);
    this.#cursor += 1;
    return Promise.resolve(next);
  }
}

function evalTask(overrides: Partial<Task> = {}): Task {
  return defineTask('1.0.0', {
    id: overrides.id ?? 'live.demo',
    title: overrides.title ?? 'demo',
    description: overrides.description ?? 'demo',
    version: '1.0.0',
    tags: [],
    difficulty: 'easy',
    goal: overrides.goal ?? 'inventory contains at least 1 items tagged minecraft:logs',
    budget: overrides.budget ?? { maxSteps: 8, maxDurationMs: 10_000 },
    profile: overrides.profile ?? 'fair-play',
    impossible: overrides.impossible ?? false,
  });
}

function context(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    repeat: overrides.repeat ?? 0,
    seed: overrides.seed ?? 1,
    signal: overrides.signal ?? new AbortController().signal,
    timeBudgetMs: overrides.timeBudgetMs ?? 10_000,
  };
}

function session(world: FakeWorld, invoke?: () => void): LiveSession {
  return {
    world,
    clock: new ManualClock(),
    invoker: {
      invoke: async () => {
        invoke?.();
        return { ok: true, value: null, durationMs: 1 };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Goal checking                                                       */
/* ------------------------------------------------------------------ */

describe('goal checking', () => {
  it('parses every goal the shipped suites use', () => {
    const goals = [
      'inventory contains at least 1 item tagged minecraft:logs',
      'inventory contains at least 8 items tagged minecraft:logs',
      'inventory contains at least 4 items tagged minecraft:planks',
      'inventory contains at least 4 minecraft:stick',
      'a minecraft:crafting_table block exists within 4 blocks of the agent',
      'inventory contains at least 1 minecraft:wooden_pickaxe',
      'inventory contains at least 1 minecraft:bedrock (unsatisfiable)',
      'inventory contains at least 1 minecraft:diamond, having only cobblestone as input (unsatisfiable)',
      'agent position is fully enclosed by solid blocks and sky access is 0',
      'agent y position is at least 5000 (beyond the build limit)',
    ];
    for (const goal of goals) {
      expect(parseGoal(goal), goal).toMatchObject({ ok: true });
    }
  });

  it('refuses a goal it cannot read rather than calling it unmet', () => {
    const parsed = parseGoal('vibe with the forest until it feels right');
    expect(parsed.ok).toBe(false);
  });

  it('strips the minecraft namespace so suite and world names meet', () => {
    const parsed = parseGoal('inventory contains at least 2 minecraft:cobblestone');
    expect(parsed).toMatchObject({
      ok: true,
      predicate: { kind: 'item-count', item: 'cobblestone', count: 2 },
    });
  });

  it('counts tagged items across variants', () => {
    const world = new FakeWorld({
      inventory: [
        { name: 'oak_log', count: 2 },
        { name: 'birch_log', count: 3 },
        { name: 'stone', count: 9 },
      ],
    });
    const parsed = parseGoal('inventory contains at least 5 items tagged minecraft:logs');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(checkPredicate(parsed.predicate, world)).toMatchObject({
      checkable: true,
      met: true,
    });
  });

  it('reads only through the WorldView, never past the gate', () => {
    const world = new FakeWorld({
      inventory: [{ name: 'oak_log', count: 1 }],
      // A truth the agent could not perceive. Crediting it would measure the
      // harness's eyesight rather than the agent's.
      hidden: [{ name: 'oak_log', count: 99 }],
    });
    const parsed = parseGoal('inventory contains at least 8 items tagged minecraft:logs');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = checkPredicate(parsed.predicate, world);
    expect(result).toMatchObject({ checkable: true, met: false });
    expect(world.reads).toEqual(['inventory']);
    expect(world.report().fairPlay).toBe(true);
    expect(world.report().total).toBe(1);
  });

  it('checks block placement within a radius, through findBlocks', () => {
    const world = new FakeWorld({
      blocks: [
        {
          name: 'crafting_table',
          position: { x: 2, y: 64, z: 0 },
          solid: true,
        },
      ],
    });
    const parsed = parseGoal(
      'a minecraft:crafting_table block exists within 4 blocks of the agent',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(checkPredicate(parsed.predicate, world)).toMatchObject({ met: true });
    expect(world.reads).toContain('findBlocks');
  });

  it('states the sky-access caveat rather than pretending to check it', () => {
    const world = new FakeWorld();
    const parsed = parseGoal(
      'agent position is fully enclosed by solid blocks and sky access is 0',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = checkPredicate(parsed.predicate, world);
    expect(result.checkable).toBe(true);
    if (!result.checkable) return;
    expect(result.met).toBe(false);
    expect(result.caveat).toMatch(/sky access/);
  });
});

/* ------------------------------------------------------------------ */
/* The live executor                                                   */
/* ------------------------------------------------------------------ */

describe('createLiveExecutor', () => {
  it('scores a met goal as success', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([
        { kind: 'skill', name: 'collectBlock', input: { name: 'oak_log' } },
        { kind: 'done', reason: 'got the log' },
      ]),
      session: () => session(world, () => world.give('oak_log', 1)),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('success');
    expect(outcome.steps).toBe(2);
    expect(executor.records[0]?.goal).toMatchObject({ met: true });
  });

  it('scores an exhausted step budget as timeout', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([
        { kind: 'skill', name: 'explore', input: {} },
      ]),
      session: () => session(world),
    });

    const outcome = await executor(
      evalTask({ budget: { maxSteps: 3, maxDurationMs: 10_000 } }),
      context(),
    );
    expect(outcome.kind).toBe('timeout');
    expect(outcome.steps).toBe(3);
  });

  it('scores an abort as timeout, not as an agent failure', async () => {
    const world = new FakeWorld();
    const controller = new AbortController();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'skill', name: 'explore', input: {} }], (step) => {
        if (step === 1) controller.abort(new Error('time budget expired'));
      }),
      session: () => session(world),
    });

    const outcome = await executor(evalTask(), context({ signal: controller.signal }));
    expect(outcome.kind).toBe('timeout');
  });

  it('scores a deliberate stop on a possible task as failure', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([
        { kind: 'done', reason: 'this is taking too long, giving up' },
      ]),
      session: () => session(world),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('failure');
  });

  it('scores a considered refusal on an impossible task as refused', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([
        {
          kind: 'done',
          reason: 'impossible: bedrock is unbreakable in survival and drops no item',
        },
      ]),
      session: () => session(world),
    });

    const outcome = await executor(
      evalTask({
        id: 'refusal.impossible.bedrock',
        goal: 'inventory contains at least 1 minecraft:bedrock (unsatisfiable)',
        impossible: true,
      }),
      context(),
    );
    expect(outcome.kind).toBe('refused');
  });

  it('does not read a refusal into a plain give-up on an impossible task', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'bored now' }]),
      session: () => session(world),
    });

    const outcome = await executor(
      evalTask({
        goal: 'inventory contains at least 1 minecraft:spawner (unsatisfiable)',
        impossible: true,
      }),
      context(),
    );
    // Scoring flips the polarity on impossible tasks, so a failure here earns
    // nothing. That is the point: an agent must say why it stopped.
    expect(outcome.kind).toBe('failure');
  });

  it('treats a refusal spoken on the last step as a refusal', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([
        { kind: 'speak', text: 'there is no such item as an obsidian sword' },
      ]),
      session: () => session(world),
    });

    const outcome = await executor(
      evalTask({
        goal: 'inventory contains at least 1 minecraft:obsidian_sword (no such item)',
        impossible: true,
        budget: { maxSteps: 1, maxDurationMs: 10_000 },
      }),
      context(),
    );
    // The loop stopped on budget, so this is a timeout, but the vocabulary test
    // itself has to see the speech.
    expect(outcome.kind).toBe('timeout');
    expect(declaresImpossible('there is no such item as an obsidian sword')).toBe(
      true,
    );
  });

  it('scores a throw as error', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'never reached' }]),
      session: () => session(world),
      prepare: () => {
        throw new Error('server refused the reset command');
      },
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/server refused the reset command/);
  });

  it('scores an unreadable goal as error, never as failure', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'done' }]),
      session: () => session(world),
    });

    const outcome = await executor(
      evalTask({ goal: 'become one with the biome' }),
      context(),
    );
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/goal could not be checked/);
  });

  it('refuses to score a run made under the wrong perception profile', async () => {
    const world = new FakeWorld({ profile: XRAY });
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'done' }]),
      session: () => session(world),
    });

    const outcome = await executor(evalTask(), context());
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toMatch(/perception profile/);
  });

  it('carries the perception report through with every attempt', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'stopping' }]),
      session: () => session(world),
    });

    await executor(evalTask(), context({ repeat: 2, seed: 77 }));
    const record = executor.records[0];
    expect(record).toBeDefined();
    expect(record?.repeat).toBe(2);
    expect(record?.seed).toBe(77);
    expect(record?.perception.total).toBeGreaterThan(0);
    expect(record?.perception.fairPlay).toBe(true);
    expect(record?.trace?.steps).toHaveLength(1);
  });

  it('says so when no world reset was performed', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'stopping' }]),
      session: () => session(world),
    });

    const outcome = await executor(evalTask(), context());
    expect(executor.records[0]?.preparedBy).toBe('nothing');
    expect(outcome.detail).toMatch(/no world reset/);
  });

  it('records the caller-provided reset when there is one, and closes the session', async () => {
    const world = new FakeWorld();
    let prepared = 0;
    let closed = 0;
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'stopping' }]),
      session: () => ({ ...session(world), close: () => void (closed += 1) }),
      prepare: () => void (prepared += 1),
    });

    await executor(evalTask(), context());
    expect(prepared).toBe(1);
    expect(closed).toBe(1);
    expect(executor.records[0]?.preparedBy).toBe('caller');
  });

  it('lets the caller override the refusal test', async () => {
    const world = new FakeWorld();
    const executor = createLiveExecutor({
      policy: new ScriptPolicy([{ kind: 'done', reason: 'nope' }]),
      session: () => session(world),
      isRefusal: () => true,
    });

    const outcome = await executor(evalTask({ impossible: true }), context());
    expect(outcome.kind).toBe('refused');
  });
});
