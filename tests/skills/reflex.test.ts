import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type { ActuationOutcome, ActuatorPort } from '../../src/embodiment/port.js';
import type {
  BlockInfo,
  BodyState,
  EntityInfo,
  ItemStack,
} from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import { observe } from '../../src/observation/observed.js';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import type { WorldView } from '../../src/perception/world-view.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { MemoryLogger, silentLogger } from '../../src/runtime/logger.js';
import { key } from '../../src/embodiment/geometry.js';
import {
  DEFAULT_THRESHOLDS,
  REFLEX_PRIORITY,
  ReflexArbiter,
  builtinReflexes,
  drowningReflex,
  fallingReflex,
  inLavaReflex,
  lowHealthReflex,
  onFireReflex,
  starvingReflex,
} from '../../src/skills/reflex/index.js';
import type { Reflex, ReflexContext } from '../../src/skills/reflex/index.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import { SkillRunner } from '../../src/skills/runner.js';
import type { Skill } from '../../src/skills/types.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const HEALTHY: BodyState = {
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

interface WorldOptions {
  readonly body?: Partial<BodyState>;
  readonly inventory?: readonly ItemStack[];
  readonly blocks?: readonly BlockInfo[];
  readonly entities?: readonly EntityInfo[];
  readonly found?: readonly BlockInfo[];
}

function fakeWorld(options: WorldOptions = {}): WorldView {
  const ledger = new PerceptionLedger();
  const body: BodyState = { ...HEALTHY, ...options.body };
  const blocks = new Map<string, BlockInfo>();
  for (const b of options.blocks ?? []) blocks.set(key(b.position), b);
  return {
    profile: FAIR_PLAY,
    body: () => observe(body, 'proprioception', 0),
    inventory: () => observe(options.inventory ?? [], 'proprioception', 0),
    blockAt: (p: Vec3Like): Observed<BlockInfo> | undefined => {
      const b = blocks.get(key(p));
      return b ? observe(b, 'sight', 0) : undefined;
    },
    nearbyEntities: () =>
      (options.entities ?? []).map((e) => observe(e, 'sight', 0)),
    findBlocks: () => (options.found ?? []).map((b) => observe(b, 'sight', 0)),
    openContainer: () => undefined,
    recollections: () => [],
    report: () => ledger.report(),
  };
}

function air(x: number, y: number, z: number): BlockInfo {
  return { name: 'air', position: { x, y, z }, solid: false };
}

function stone(x: number, y: number, z: number): BlockInfo {
  return { name: 'stone', position: { x, y, z }, solid: true };
}

class RecordingActuator implements ActuatorPort {
  readonly calls: { name: string; args: readonly unknown[] }[] = [];

  #record(name: string, ...args: unknown[]): Promise<ActuationOutcome> {
    this.calls.push({ name, args });
    return Promise.resolve({ ok: true });
  }

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  moveTo(p: Vec3Like): Promise<ActuationOutcome> {
    return this.#record('moveTo', p);
  }
  lookAt(p: Vec3Like): Promise<ActuationOutcome> {
    return this.#record('lookAt', p);
  }
  dig(p: Vec3Like): Promise<ActuationOutcome> {
    return this.#record('dig', p);
  }
  placeBlock(): Promise<ActuationOutcome> {
    return this.#record('placeBlock');
  }
  equip(): Promise<ActuationOutcome> {
    return this.#record('equip');
  }
  consume(item: string): Promise<ActuationOutcome> {
    return this.#record('consume', item);
  }
  attack(): Promise<ActuationOutcome> {
    return this.#record('attack');
  }
  dropItem(): Promise<ActuationOutcome> {
    return this.#record('dropItem');
  }
  craft(): Promise<ActuationOutcome> {
    return this.#record('craft');
  }
  openContainer(): Promise<undefined> {
    this.calls.push({ name: 'openContainer', args: [] });
    return Promise.resolve(undefined);
  }
  closeContainer(): Promise<void> {
    this.calls.push({ name: 'closeContainer', args: [] });
    return Promise.resolve();
  }
  withdraw(): Promise<ActuationOutcome> {
    return this.#record('withdraw');
  }
  deposit(): Promise<ActuationOutcome> {
    return this.#record('deposit');
  }
  chat(): Promise<ActuationOutcome> {
    return this.#record('chat');
  }
  stop(): Promise<void> {
    this.calls.push({ name: 'stop', args: [] });
    return Promise.resolve();
  }
}

function reflexCtx(world: WorldView, act: ActuatorPort): ReflexContext {
  return { world, act, clock: new ManualClock(), log: silentLogger };
}

function stubReflex(name: string, priority: number, fires = true): Reflex {
  return {
    name,
    priority,
    shouldFire: () => fires,
    act: async () => {},
  };
}

// ---------------------------------------------------------------------------

describe('ReflexArbiter', () => {
  it('returns undefined when nothing fires', () => {
    const arbiter = new ReflexArbiter([stubReflex('a', 10, false)]);
    expect(arbiter.evaluate(fakeWorld())).toBeUndefined();
  });

  it('picks the highest-priority reflex that fires', () => {
    const arbiter = new ReflexArbiter([
      stubReflex('low', 1),
      stubReflex('high', 100),
      stubReflex('mid', 50),
    ]);
    expect(arbiter.evaluate(fakeWorld())?.name).toBe('high');
  });

  it('ignores higher-priority reflexes whose condition is false', () => {
    const arbiter = new ReflexArbiter([
      stubReflex('high', 100, false),
      stubReflex('mid', 50),
    ]);
    expect(arbiter.evaluate(fakeWorld())?.name).toBe('mid');
  });

  it('breaks priority ties by registration order', () => {
    const arbiter = new ReflexArbiter([
      stubReflex('first', 10),
      stubReflex('second', 10),
    ]);
    expect(arbiter.evaluate(fakeWorld())?.name).toBe('first');
    expect(arbiter.list().map((r) => r.name)).toEqual(['first', 'second']);
  });

  it('keeps its list sorted by descending priority as reflexes are added', () => {
    const arbiter = new ReflexArbiter();
    arbiter.add(stubReflex('c', 1)).add(stubReflex('a', 100)).add(stubReflex('b', 50));
    expect(arbiter.list().map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(arbiter.size).toBe(3);
  });

  it('removes reflexes by name', () => {
    const arbiter = new ReflexArbiter([stubReflex('a', 10)]);
    expect(arbiter.remove('a')).toBe(true);
    expect(arbiter.remove('a')).toBe(false);
    expect(arbiter.size).toBe(0);
  });

  it('reports every firing reflex, highest first', () => {
    const arbiter = new ReflexArbiter([
      stubReflex('low', 1),
      stubReflex('high', 100),
      stubReflex('off', 50, false),
    ]);
    expect(arbiter.evaluateAll(fakeWorld()).map((r) => r.name)).toEqual([
      'high',
      'low',
    ]);
  });

  it('does not abort when nothing fires', () => {
    const arbiter = new ReflexArbiter([stubReflex('a', 10, false)]);
    const running = new AbortController();
    expect(arbiter.preempt(fakeWorld(), running)).toBeUndefined();
    expect(running.signal.aborted).toBe(false);
  });
});

describe('builtin reflexes', () => {
  it('fires in lava and climbs', async () => {
    const r = inLavaReflex();
    expect(r.shouldFire(fakeWorld({ body: { inLava: true } }))).toBe(true);
    expect(r.shouldFire(fakeWorld())).toBe(false);

    const act = new RecordingActuator();
    await r.act(reflexCtx(fakeWorld({ body: { inLava: true } }), act));
    expect(act.names).toEqual(['stop', 'moveTo']);
    expect(act.calls[1]?.args[0]).toEqual({ x: 0, y: 66, z: 0 });
  });

  it('fires when drowning but not when merely swimming', async () => {
    const r = drowningReflex();
    expect(
      r.shouldFire(fakeWorld({ body: { inWater: true, oxygen: 3 } })),
    ).toBe(true);
    expect(
      r.shouldFire(fakeWorld({ body: { inWater: true, oxygen: 20 } })),
    ).toBe(false);
    expect(r.shouldFire(fakeWorld({ body: { oxygen: 0 } }))).toBe(false);

    const act = new RecordingActuator();
    await r.act(reflexCtx(fakeWorld({ body: { inWater: true, oxygen: 1 } }), act));
    expect(act.names).toEqual(['stop', 'moveTo']);
  });

  it('fires when burning and heads for water', async () => {
    const r = onFireReflex();
    expect(r.shouldFire(fakeWorld({ body: { isBurning: true } }))).toBe(true);
    // Already in water: the fire is going out by itself.
    expect(
      r.shouldFire(fakeWorld({ body: { isBurning: true, inWater: true } })),
    ).toBe(false);

    const act = new RecordingActuator();
    const world = fakeWorld({
      body: { isBurning: true },
      found: [{ name: 'water', position: { x: 5, y: 63, z: 2 }, solid: false }],
    });
    await r.act(reflexCtx(world, act));
    expect(act.names).toEqual(['moveTo']);
    expect(act.calls[0]?.args[0]).toEqual({ x: 5, y: 63, z: 2 });
  });

  it('stops rather than wandering when burning with no water in sight', async () => {
    const act = new RecordingActuator();
    await onFireReflex().act(
      reflexCtx(fakeWorld({ body: { isBurning: true } }), act),
    );
    expect(act.names).toEqual(['stop']);
  });

  it('fires when falling over a known drop', () => {
    const r = fallingReflex();
    const blocks = [air(0, 63, 0), air(0, 62, 0), air(0, 61, 0), air(0, 60, 0)];
    expect(r.shouldFire(fakeWorld({ body: { onGround: false }, blocks }))).toBe(
      true,
    );
    // On the ground: not falling, whatever is below.
    expect(r.shouldFire(fakeWorld({ blocks }))).toBe(false);
  });

  it('does not fire on a short drop or on unseen ground', () => {
    const r = fallingReflex();
    const shallow = [air(0, 63, 0), air(0, 62, 0), stone(0, 61, 0)];
    expect(
      r.shouldFire(fakeWorld({ body: { onGround: false }, blocks: shallow })),
    ).toBe(false);
    // Nothing known below: unknown is not the same as empty, so hold fire.
    expect(r.shouldFire(fakeWorld({ body: { onGround: false } }))).toBe(false);
  });

  it('fires on low health and runs away from a hostile', async () => {
    const r = lowHealthReflex();
    expect(r.shouldFire(fakeWorld({ body: { health: 4 } }))).toBe(true);
    expect(r.shouldFire(fakeWorld())).toBe(false);

    const act = new RecordingActuator();
    const world = fakeWorld({
      body: { health: 3 },
      entities: [
        {
          id: 1,
          name: 'zombie',
          kind: 'mob',
          position: { x: 3, y: 64, z: 0 },
          hostile: true,
        },
      ],
    });
    await r.act(reflexCtx(world, act));
    expect(act.names).toEqual(['moveTo']);
    const target = act.calls[0]?.args[0] as Vec3Like;
    // Directly away from the zombie, which stood at +x.
    expect(target.x).toBeCloseTo(-DEFAULT_THRESHOLDS.fleeDistance);
    expect(target.z).toBeCloseTo(0);
  });

  it('just stops on low health with nothing hostile nearby', async () => {
    const act = new RecordingActuator();
    await lowHealthReflex().act(
      reflexCtx(fakeWorld({ body: { health: 2 } }), act),
    );
    expect(act.names).toEqual(['stop']);
  });

  it('fires when starving with food, and eats the most preferred one', async () => {
    const r = starvingReflex();
    const world = fakeWorld({
      body: { food: 2 },
      inventory: [
        { name: 'bread', count: 3 },
        { name: 'golden_apple', count: 1 },
      ],
    });
    expect(r.shouldFire(world)).toBe(true);

    const act = new RecordingActuator();
    await r.act(reflexCtx(world, act));
    expect(act.calls).toEqual([{ name: 'consume', args: ['golden_apple'] }]);
  });

  it('does not fire when starving with nothing edible', () => {
    const r = starvingReflex();
    expect(
      r.shouldFire(
        fakeWorld({ body: { food: 1 }, inventory: [{ name: 'cobblestone', count: 64 }] }),
      ),
    ).toBe(false);
    expect(r.shouldFire(fakeWorld({ inventory: [{ name: 'bread', count: 1 }] }))).toBe(
      false,
    );
  });

  it('ranks lava and drowning above low health', () => {
    const arbiter = new ReflexArbiter(builtinReflexes());
    const dying = {
      health: 1,
      food: 0,
      inLava: true,
      inWater: true,
      oxygen: 0,
      isBurning: true,
    };
    expect(arbiter.evaluate(fakeWorld({ body: dying }))?.name).toBe('in-lava');
    expect(
      arbiter.evaluate(fakeWorld({ body: { ...dying, inLava: false } }))?.name,
    ).toBe('drowning');
    expect(REFLEX_PRIORITY.IN_LAVA).toBeGreaterThan(REFLEX_PRIORITY.LOW_HEALTH);
    expect(REFLEX_PRIORITY.DROWNING).toBeGreaterThan(REFLEX_PRIORITY.LOW_HEALTH);
  });

  it('leaves a healthy agent alone', () => {
    const arbiter = new ReflexArbiter(builtinReflexes());
    expect(arbiter.evaluate(fakeWorld())).toBeUndefined();
  });
});

describe('reflex pre-emption of a running skill', () => {
  it('aborts the running skill, which the runner reports as interrupted', async () => {
    const Input = z.object({ target: z.string() });
    const Output = z.object({ done: z.boolean() });
    let sawAbort = false;

    const skill: Skill<{ target: string }, { done: boolean }> = {
      name: 'long-walk',
      summary: 'walks for a long time',
      description: 'walks; will not stop on its own',
      input: Input,
      output: Output,
      timeoutMs: 60_000,
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({
              ok: false,
              kind: 'interrupted',
              message: 'stopped',
              retryable: false,
              durationMs: 0,
            });
          });
        }),
    };

    const registry = new SkillRegistry().register(skill);
    const reliability = new ReliabilityTracker();
    const clock = new ManualClock();
    const runner = new SkillRunner(
      registry,
      reliability,
      clock,
      new MemoryLogger(() => clock.now()),
    );

    const act = new RecordingActuator();
    const running = new AbortController();
    const pending = runner.run(
      'long-walk',
      { target: 'far' },
      { world: fakeWorld(), act, signal: running.signal },
    );

    // A tick arrives in which the agent is on fire.
    const arbiter = new ReflexArbiter(builtinReflexes());
    const burning = fakeWorld({ body: { isBurning: true } });
    const fired = arbiter.preempt(burning, running);

    expect(fired?.name).toBe('on-fire');
    expect(running.signal.aborted).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('interrupted');
    expect(sawAbort).toBe(true);

    // The pre-empted attempt is still recorded: a skill that keeps getting
    // interrupted is a skill that is not working, whoever's fault that is.
    expect(reliability.stats('long-walk')).toMatchObject({
      attempts: 1,
      successes: 0,
    });

    // And the reflex itself can now act.
    await fired?.act(reflexCtx(burning, act));
    expect(act.names).toContain('stop');
  });
});
