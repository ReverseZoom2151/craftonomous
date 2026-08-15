import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type { ActuationOutcome, ActuatorPort } from '../../src/embodiment/port.js';
import type { BodyState, ItemStack } from '../../src/embodiment/types.js';
import { observe } from '../../src/observation/observed.js';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import type { WorldView } from '../../src/perception/world-view.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { MemoryLogger } from '../../src/runtime/logger.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import { SkillRunner } from '../../src/skills/runner.js';
import type { PreconditionResult, Skill, SkillContext } from '../../src/skills/types.js';
import { HOLDS, fail, fails, succeed } from '../../src/skills/types.js';

// ---------------------------------------------------------------------------
// Doubles. Built here rather than imported so these tests never need a server,
// and never wait on another part of the tree being finished.
// ---------------------------------------------------------------------------

const BODY: BodyState = {
  position: { x: 0, y: 64, z: 0 },
  eyePosition: { x: 0, y: 65.6, z: 0 },
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

function fakeWorld(body: BodyState = BODY, inventory: ItemStack[] = []): WorldView {
  const ledger = new PerceptionLedger();
  return {
    profile: FAIR_PLAY,
    body: () => observe(body, 'proprioception', 0),
    inventory: () => observe(inventory as readonly ItemStack[], 'proprioception', 0),
    blockAt: () => undefined,
    nearbyEntities: () => [],
    findBlocks: () => [],
    openContainer: () => undefined,
    recollections: () => [],
    // Unexercised here; hearing and testimony have their own tests.
    sounds: () => [],
    testimony: () => [],
    checkPositionClaim: (claim) => claim,
    report: () => ledger.report(),
  };
}

class RecordingActuator implements ActuatorPort {
  readonly calls: string[] = [];

  #ok(name: string): Promise<ActuationOutcome> {
    this.calls.push(name);
    return Promise.resolve({ ok: true });
  }

  moveTo(_p: Vec3Like): Promise<ActuationOutcome> {
    return this.#ok('moveTo');
  }
  lookAt(_p: Vec3Like): Promise<ActuationOutcome> {
    return this.#ok('lookAt');
  }
  dig(_p: Vec3Like): Promise<ActuationOutcome> {
    return this.#ok('dig');
  }
  placeBlock(): Promise<ActuationOutcome> {
    return this.#ok('placeBlock');
  }
  equip(): Promise<ActuationOutcome> {
    return this.#ok('equip');
  }
  consume(item: string): Promise<ActuationOutcome> {
    this.calls.push(`consume:${item}`);
    return Promise.resolve({ ok: true });
  }
  attack(): Promise<ActuationOutcome> {
    return this.#ok('attack');
  }
  dropItem(): Promise<ActuationOutcome> {
    return this.#ok('dropItem');
  }
  craft(): Promise<ActuationOutcome> {
    return this.#ok('craft');
  }
  openContainer(): Promise<undefined> {
    this.calls.push('openContainer');
    return Promise.resolve(undefined);
  }
  closeContainer(): Promise<void> {
    this.calls.push('closeContainer');
    return Promise.resolve();
  }
  withdraw(): Promise<ActuationOutcome> {
    return this.#ok('withdraw');
  }
  deposit(): Promise<ActuationOutcome> {
    return this.#ok('deposit');
  }
  chat(): Promise<ActuationOutcome> {
    return this.#ok('chat');
  }
  stop(): Promise<void> {
    this.calls.push('stop');
    return Promise.resolve();
  }
}

const Input = z.object({ target: z.string() });
const Output = z.object({ moved: z.boolean() });
type In = z.infer<typeof Input>;
type Out = z.infer<typeof Output>;

interface SkillOverrides {
  readonly name?: string;
  readonly timeoutMs?: number;
  readonly precondition?: (
    ctx: SkillContext,
    input: In,
  ) => Promise<PreconditionResult>;
  readonly run?: Skill<In, Out>['run'];
}

function makeSkill(overrides: SkillOverrides = {}): Skill<In, Out> {
  const skill: Skill<In, Out> = {
    name: overrides.name ?? 'walk',
    summary: 'walk somewhere',
    description: 'walks somewhere; not for climbing',
    input: Input,
    output: Output,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    run:
      overrides.run ??
      (async (ctx) => {
        await ctx.act.moveTo({ x: 1, y: 1, z: 1 });
        return succeed({ moved: true }, 0);
      }),
  };
  if (overrides.precondition) skill.precondition = overrides.precondition;
  return skill;
}

interface Harness {
  readonly runner: SkillRunner;
  readonly registry: SkillRegistry;
  readonly reliability: ReliabilityTracker;
  readonly clock: ManualClock;
  readonly act: RecordingActuator;
  readonly ctx: { world: WorldView; act: ActuatorPort };
  readonly log: MemoryLogger;
}

function harness(skill: Skill<In, Out> = makeSkill()): Harness {
  const registry = new SkillRegistry().register(skill);
  const reliability = new ReliabilityTracker();
  const clock = new ManualClock(1000);
  const log = new MemoryLogger(() => clock.now());
  const act = new RecordingActuator();
  return {
    runner: new SkillRunner(registry, reliability, clock, log),
    registry,
    reliability,
    clock,
    act,
    log,
    ctx: { world: fakeWorld(), act },
  };
}

const never = () => new Promise<never>(() => {});

// ---------------------------------------------------------------------------

describe('SkillRunner', () => {
  it('runs a valid skill and returns its output', async () => {
    const h = harness();
    const r = await h.runner.run<In, Out>('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ moved: true });
    expect(h.act.calls).toEqual(['moveTo']);
  });

  it('fails an unknown skill without recording it', async () => {
    const h = harness();
    const r = await h.runner.run('nope', {}, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unknown');
    expect(h.reliability.stats('nope').attempts).toBe(0);
  });

  it('rejects invalid input before the skill can act', async () => {
    let ran = false;
    const h = harness(
      makeSkill({
        run: async () => {
          ran = true;
          return succeed({ moved: true }, 0);
        },
      }),
    );
    const r = await h.runner.run('walk', { target: 42 }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('invalid-input');
    expect(ran).toBe(false);
    expect(h.act.calls).toEqual([]);
  });

  it('does not act when a precondition fails, and reports the reason', async () => {
    let ran = false;
    const h = harness(
      makeSkill({
        precondition: async () => fails('no pickaxe'),
        run: async () => {
          ran = true;
          return succeed({ moved: true }, 0);
        },
      }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('precondition');
      expect(r.message).toBe('no pickaxe');
    }
    expect(ran).toBe(false);
    expect(h.act.calls).toEqual([]);
  });

  it('runs when a precondition holds', async () => {
    const h = harness(makeSkill({ precondition: async () => HOLDS }));
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(true);
  });

  it('times out a skill that overruns its budget', async () => {
    const h = harness(makeSkill({ timeoutMs: 10, run: never }));
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('timeout');
      expect(r.retryable).toBe(true);
    }
    expect(h.reliability.stats('walk').successes).toBe(0);
    expect(h.reliability.stats('walk').attempts).toBe(1);
  });

  it('honours a per-call timeout override', async () => {
    const h = harness(makeSkill({ timeoutMs: 60_000, run: never }));
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx, {
      timeoutMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });

  it('reports an external abort as interrupted', async () => {
    const h = harness(makeSkill({ timeoutMs: 60_000, run: never }));
    const external = new AbortController();
    const pending = h.runner.run('walk', { target: 'home' }, {
      ...h.ctx,
      signal: external.signal,
    });
    external.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('interrupted');
      expect(r.retryable).toBe(false);
    }
  });

  it('refuses immediately when the caller signal is already aborted', async () => {
    const h = harness();
    const r = await h.runner.run('walk', { target: 'home' }, {
      ...h.ctx,
      signal: AbortSignal.abort(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('interrupted');
    expect(h.act.calls).toEqual([]);
  });

  it('passes a combined signal the skill can cooperate with', async () => {
    let sawAbort = false;
    const h = harness(
      makeSkill({
        timeoutMs: 60_000,
        run: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
              resolve(fail('interrupted', 'stopped', 0));
            });
          }),
      }),
    );
    const external = new AbortController();
    const pending = h.runner.run('walk', { target: 'home' }, {
      ...h.ctx,
      signal: external.signal,
    });
    external.abort();
    await pending;
    expect(sawAbort).toBe(true);
  });

  it('converts a throwing skill into a failure rather than a crash', async () => {
    const h = harness(
      makeSkill({
        run: () => {
          throw new Error('pathfinder exploded');
        },
      }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unknown');
      expect(r.message).toBe('pathfinder exploded');
    }
    expect(h.reliability.stats('walk')).toMatchObject({
      attempts: 1,
      successes: 0,
    });
  });

  it('converts a rejected promise into a failure', async () => {
    const h = harness(
      makeSkill({ run: async () => Promise.reject(new Error('boom')) }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('boom');
  });

  it('fails when the output does not match the schema', async () => {
    const h = harness(
      makeSkill({
        run: async () =>
          succeed({ moved: 'yes' } as unknown as Out, 0),
      }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unknown');
      expect(r.message).toContain('output failed validation');
    }
    expect(h.reliability.stats('walk').successes).toBe(0);
  });

  it('passes a skill-declared failure through unchanged', async () => {
    const h = harness(
      makeSkill({ run: async () => fail('unreachable', 'no path', 5) }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unreachable');
      expect(r.retryable).toBe(true);
    }
  });

  it('records both successes and failures against reliability', async () => {
    let succeedNext = true;
    const h = harness(
      makeSkill({
        run: async () => {
          const out = succeedNext
            ? succeed<Out>({ moved: true }, 0)
            : fail<Out>('unreachable', 'no path', 0);
          succeedNext = !succeedNext;
          return out;
        },
      }),
    );
    for (let i = 0; i < 4; i += 1) {
      await h.runner.run('walk', { target: `t${i}` }, h.ctx);
    }
    const stats = h.reliability.stats('walk');
    expect(stats.attempts).toBe(4);
    expect(stats.successes).toBe(2);
    expect(stats.rate).toBe(0.5);
  });

  it('measures duration from the injected clock, not wall time', async () => {
    const h = harness(
      makeSkill({
        run: async (ctx) => {
          (ctx.clock as ManualClock).advance(250);
          return succeed({ moved: true }, 0);
        },
      }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.durationMs).toBe(250);
    expect(h.reliability.stats('walk').meanDurationMs).toBe(250);
  });

  it('refuses a retired skill unless allowRetired is passed', async () => {
    const h = harness();
    for (let i = 0; i < 8; i += 1) {
      h.reliability.record('walk', { succeeded: false, durationMs: 1 });
    }
    expect(h.reliability.isRetired('walk')).toBe(true);

    const refused = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.kind).toBe('precondition');
      expect(refused.message).toContain('retired');
    }
    expect(h.act.calls).toEqual([]);

    const forced = await h.runner.run('walk', { target: 'home' }, h.ctx, {
      allowRetired: true,
    });
    expect(forced.ok).toBe(true);
    expect(h.act.calls).toEqual(['moveTo']);
  });

  it('detects runaway repetition of the same skill and input', async () => {
    const h = harness(
      makeSkill({ run: async () => fail('unreachable', 'no path', 0) }),
    );
    const kinds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await h.runner.run(
        'walk',
        { target: 'home' },
        h.ctx,
        { allowRetired: true },
      );
      if (!r.ok) kinds.push(r.message);
    }
    expect(kinds.filter((m) => m === 'no path')).toHaveLength(8);
    expect(kinds.filter((m) => m.startsWith('repetition detected'))).toHaveLength(
      2,
    );
  });

  it('does not trip repetition when the input changes', async () => {
    const h = harness(
      makeSkill({ run: async () => fail('unreachable', 'no path', 0) }),
    );
    for (let i = 0; i < 20; i += 1) {
      const r = await h.runner.run(
        'walk',
        { target: `t${i}` },
        h.ctx,
        { allowRetired: true },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toBe('no path');
    }
  });

  it('resets the repetition counter after a success', async () => {
    let failing = true;
    const h = harness(
      makeSkill({
        run: async () =>
          failing
            ? fail<Out>('unreachable', 'no path', 0)
            : succeed<Out>({ moved: true }, 0),
      }),
    );
    for (let i = 0; i < 7; i += 1) {
      await h.runner.run('walk', { target: 'home' }, h.ctx, {
        allowRetired: true,
      });
    }
    failing = false;
    const ok = await h.runner.run('walk', { target: 'home' }, h.ctx, {
      allowRetired: true,
    });
    expect(ok.ok).toBe(true);

    failing = true;
    const next = await h.runner.run('walk', { target: 'home' }, h.ctx, {
      allowRetired: true,
    });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.message).toBe('no path');
  });

  it('honours a custom repetition limit', async () => {
    const registry = new SkillRegistry().register(
      makeSkill({ run: async () => fail('unreachable', 'no path', 0) }),
    );
    const reliability = new ReliabilityTracker();
    const runner = new SkillRunner(
      registry,
      reliability,
      new ManualClock(),
      undefined,
      { repetitionLimit: 2 },
    );
    const ctx = { world: fakeWorld(), act: new RecordingActuator() };
    await runner.run('walk', { target: 'home' }, ctx, { allowRetired: true });
    await runner.run('walk', { target: 'home' }, ctx, { allowRetired: true });
    const third = await runner.run('walk', { target: 'home' }, ctx, {
      allowRetired: true,
    });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.message).toContain('repetition detected');
  });

  it('rejects a skill that returns something that is not a result', async () => {
    const h = harness(
      makeSkill({ run: async () => 'nonsense' as unknown as never }),
    );
    const r = await h.runner.run('walk', { target: 'home' }, h.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('non-result');
  });
});
