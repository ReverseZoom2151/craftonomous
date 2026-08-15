import { describe, expect, it } from 'vitest';

import type { LifecycleSource } from '../../src/runtime/bootstrap.js';
import { silentLogger } from '../../src/runtime/logger.js';
import type {
  JoinedSession,
  MineflayerBotLike,
  PathfinderGoals,
  Vec3Factory,
} from '../../src/embodiment/mineflayer/index.js';
import {
  JOIN_WINDOW_MS,
  JoinBudget,
  MAX_JOIN_ATTEMPTS,
  MineflayerActuatorPort,
  MineflayerEmbodiment,
  MineflayerSensorPort,
  SessionSupervisor,
  supervise,
} from '../../src/embodiment/mineflayer/index.js';

/**
 * Everything here runs against a hand-built bot object. No server, no socket,
 * no timers that outlive a test: a rebind is a question about who is listening
 * to what, and that is answerable offline.
 */

const vec3: Vec3Factory = (x, y, z) => ({ x, y, z });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeBot {
  readonly bot: MineflayerBotLike;
  emit(event: string, ...args: unknown[]): void;
  listenerCount(event: string): number;
  readonly stops: () => number;
  readonly digStops: () => number;
  readonly quits: () => string[];
}

function fakeBot(options: { readonly name?: string } = {}): FakeBot {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  let stops = 0;
  let digStops = 0;
  const quits: string[] = [];

  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {},
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    game: { dimension: options.name ?? 'overworld' },
    pathfinder: {
      goto: () => new Promise<void>(() => {}),
      setGoal: () => {},
      stop: () => {
        stops += 1;
      },
    },
    blockAt: (p: { x: number; y: number; z: number }) => ({
      name: 'stone',
      position: p,
      boundingBox: 'block',
    }),
    findBlocks: () => [],
    // Neither a dig nor a path ever settles here, which is exactly what a
    // dropped socket does: the point is that a rebind releases the caller.
    dig: () => new Promise<void>(() => {}),
    stopDigging: () => {
      digStops += 1;
    },
    clearControlStates: () => {},
    chat: () => {},
    quit: (reason?: string) => {
      quits.push(reason ?? '');
    },
    on(event: string, listener: (...args: unknown[]) => void): void {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    once(): void {},
    removeListener(event: string, listener: (...args: unknown[]) => void): void {
      const existing = listeners.get(event) ?? [];
      const at = existing.indexOf(listener);
      if (at >= 0) existing.splice(at, 1);
      listeners.set(event, existing);
    },
  } as unknown as MineflayerBotLike;

  return {
    bot,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])])
        listener(...args);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    stops: () => stops,
    digStops: () => digStops,
    quits: () => quits,
  };
}

const goals: PathfinderGoals = {
  near: () => ({}),
  block: () => ({}),
};

function session(fake: FakeBot): JoinedSession {
  return { bot: fake.bot, vec3, goals };
}

function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('MineflayerSensorPort.rebind', () => {
  it('reads from the new bot and hears its events', () => {
    const first = fakeBot({ name: 'overworld' });
    const second = fakeBot({ name: 'the_nether' });
    const sensors = new MineflayerSensorPort(first.bot, vec3);

    sensors.rebind(second.bot, vec3);
    second.emit('chat', 'Steve', 'hello from the new session');

    expect(sensors.bot).toBe(second.bot);
    expect(sensors.body().dimension).toBe('the_nether');
    expect(sensors.drainChat()).toEqual([
      { from: 'Steve', text: 'hello from the new session', private: false },
    ]);
  });

  it('stops listening to the old bot instead of leaking a listener set', () => {
    const first = fakeBot();
    const second = fakeBot();
    const sensors = new MineflayerSensorPort(first.bot, vec3);
    const before = first.listenerCount('chat');
    expect(before).toBeGreaterThan(0);

    sensors.rebind(second.bot, vec3);

    expect(first.listenerCount('chat')).toBe(0);
    expect(first.listenerCount('soundEffectHeard')).toBe(0);
    expect(second.listenerCount('chat')).toBe(before);

    // The dead socket can keep talking; nothing of it reaches the buffers.
    first.emit('chat', 'Ghost', 'from a session that ended');
    first.emit('soundEffectHeard', 'entity.creeper.primed', {
      x: 1,
      y: 2,
      z: 3,
    });
    expect(sensors.drainChat()).toEqual([]);
    expect(sensors.drainSounds()).toEqual([]);
  });

  it('clears undrained events, which belonged to a world that has moved on', () => {
    const first = fakeBot();
    const second = fakeBot();
    const sensors = new MineflayerSensorPort(first.bot, vec3);

    first.emit('chat', 'Steve', 'before the drop');
    first.emit('soundEffectHeard', 'entity.zombie.step', { x: 5, y: 64, z: 5 });
    sensors.rebind(second.bot, vec3);

    expect(sensors.drainChat()).toEqual([]);
    expect(sensors.drainSounds()).toEqual([]);
  });

  it('does not re-subscribe to a bot it has detached from', () => {
    const first = fakeBot();
    const sensors = new MineflayerSensorPort(first.bot, vec3);
    sensors.detach();
    sensors.detach();
    expect(first.listenerCount('chat')).toBe(0);
    first.emit('chat', 'Steve', 'ignored');
    expect(sensors.drainChat()).toEqual([]);
  });
});

describe('MineflayerActuatorPort.rebind', () => {
  it('abandons an in-flight dig rather than leaving the caller waiting', async () => {
    const first = fakeBot();
    const second = fakeBot();
    const actuators = new MineflayerActuatorPort(
      first.bot,
      vec3,
      goals,
      silentLogger,
    );

    const digging = actuators.dig({ x: 0, y: 63, z: 0 });
    actuators.rebind(second.bot, vec3, goals);

    const outcome = await digging;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/abandoned/);
    // The old body was told to stop, so a half-open session is not left digging.
    expect(first.digStops()).toBeGreaterThan(0);
    expect(actuators.bot).toBe(second.bot);
  });

  it('abandons an in-flight pathfinder goal and stops the old pathfinder', async () => {
    const first = fakeBot();
    const second = fakeBot();
    const actuators = new MineflayerActuatorPort(
      first.bot,
      vec3,
      goals,
      silentLogger,
    );

    const moving = actuators.moveTo({ x: 10, y: 64, z: 10 });
    actuators.rebind(second.bot, vec3, goals);

    const outcome = await moving;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/abandoned/);
    expect(first.stops()).toBeGreaterThan(0);
    expect(second.stops()).toBe(0);
  });
});

describe('MineflayerEmbodiment.rebind', () => {
  it('keeps every reference valid and reports being connected again', () => {
    const first = fakeBot({ name: 'overworld' });
    const second = fakeBot({ name: 'the_end' });
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    const heldSensors = body.sensors;
    const heldActuators = body.actuators;

    first.emit('end', 'socket closed');
    expect(body.connected).toBe(false);

    body.rebind(second.bot, vec3, goals);

    expect(body.connected).toBe(true);
    expect(body.sensors).toBe(heldSensors);
    expect(body.actuators).toBe(heldActuators);
    expect(heldSensors.body().dimension).toBe('the_end');
    expect(heldActuators.bot).toBe(second.bot);

    // The old bot's `end` listener is gone, so a late event from the dead
    // socket cannot mark the live session disconnected.
    first.emit('end', 'late noise');
    expect(body.connected).toBe(true);
  });
});

describe('supervised reconnection on the live wiring', () => {
  it('rebinds the ports instead of replacing the port object', async () => {
    const first = fakeBot({ name: 'overworld' });
    const second = fakeBot({ name: 'the_nether' });
    const time = fakeTime();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    // A reference resolved before the drop, exactly as the wiring layer holds.
    const heldSensors = body.sensors;

    const supervisor = supervise(body, async () => session(second), {
      now: time.now,
      sleep: time.sleep,
    });

    first.emit('end', 'connection reset');
    await settle();

    expect(supervisor.generation).toBe(2);
    expect(body.sensors).toBe(heldSensors);
    expect(heldSensors.bot).toBe(second.bot);
    expect(heldSensors.body().dimension).toBe('the_nether');
    expect(body.connected).toBe(true);

    // Both the supervisor and the ports followed the swap: a death and a chat
    // message from the new session are both seen.
    second.emit('death');
    second.emit('chat', 'Alex', 'still here');
    expect(supervisor.deaths).toBe(1);
    expect(heldSensors.drainChat()).toHaveLength(1);
  });

  it('leaves nothing subscribed to the session that dropped', async () => {
    const first = fakeBot();
    const second = fakeBot();
    const time = fakeTime();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    supervise(body, async () => session(second), {
      now: time.now,
      sleep: time.sleep,
    });

    first.emit('end', 'connection reset');
    await settle();

    for (const event of ['chat', 'end', 'death', 'kicked', 'spawn']) {
      expect(first.listenerCount(event)).toBe(0);
    }
    expect(second.listenerCount('end')).toBeGreaterThan(0);
  });

  it('never reconnects after an intentional close, and lets go of the bot', async () => {
    const first = fakeBot();
    let rejoins = 0;
    const time = fakeTime();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    const supervisor = supervise(
      body,
      async () => {
        rejoins += 1;
        return session(fakeBot());
      },
      { now: time.now, sleep: time.sleep },
    );

    await body.disconnect();
    // Whatever the socket does on the way out changes nothing.
    first.emit('end', 'quit');
    await settle();

    expect(rejoins).toBe(0);
    expect(supervisor.closed).toBe(true);
    expect(body.connected).toBe(false);
    expect(first.quits()).toEqual(['disconnect']);
    for (const event of ['chat', 'end', 'death', 'kicked']) {
      expect(first.listenerCount(event)).toBe(0);
    }
  });

  it('refuses to come back to life if the close lands mid-reconnect', async () => {
    const first = fakeBot();
    const second = fakeBot();
    const time = fakeTime();
    const gate = deferred<void>();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    const supervisor = supervise(
      body,
      async () => {
        await gate.promise;
        return session(second);
      },
      { now: time.now, sleep: time.sleep },
    );

    first.emit('end', 'connection reset');
    await settle();
    await body.disconnect();
    gate.resolve();
    await settle();

    expect(body.connected).toBe(false);
    // The session that arrived too late is closed rather than left open, and
    // no generation is announced for a body nobody will ever use.
    expect(second.quits().length).toBeGreaterThan(0);
    expect(supervisor.generation).toBe(1);
    expect(second.listenerCount('end')).toBe(0);
  });

  it('draws reconnects from the same join budget as the first join', async () => {
    const time = fakeTime();
    const budget = new JoinBudget();
    // The account has already spent its budget, a moment ago.
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) budget.record(0);
    const first = fakeBot();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    const supervisor = supervise(body, async () => session(fakeBot()), {
      budget,
      now: time.now,
      sleep: time.sleep,
    });
    const seen: { kind: string; delayMs?: number }[] = [];
    supervisor.on((event) => {
      seen.push(
        event.kind === 'reconnecting'
          ? { kind: event.kind, delayMs: event.delayMs }
          : { kind: event.kind },
      );
    });

    first.emit('end');
    await settle();

    const firstAttempt = seen.find((e) => e.kind === 'reconnecting');
    expect(firstAttempt?.delayMs).toBe(JOIN_WINDOW_MS);
  });
});

describe('the join budget', () => {
  it('refuses a seventh join inside thirty seconds, and in fact a sixth', () => {
    // Mojang's own limit is six per thirty seconds. Even a budget set to that
    // raw figure refuses the seventh.
    const raw = new JoinBudget(6);
    for (let i = 0; i < 6; i += 1) raw.record(i * 1_000);
    expect(raw.used(5_000)).toBe(6);
    expect(raw.waitFor(5_000)).toBeGreaterThan(0);
    expect(raw.waitFor(JOIN_WINDOW_MS)).toBe(0);

    // Ours is stricter on purpose: one join of headroom for the account.
    const ours = new JoinBudget();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) ours.record(i * 1_000);
    expect(ours.waitFor(5_000)).toBeGreaterThan(0);
    expect(MAX_JOIN_ATTEMPTS).toBeLessThan(6);
  });
});

describe('the lifecycle a wiring layer subscribes to', () => {
  it('satisfies the runtime structural LifecycleSource', async () => {
    const first = fakeBot();
    const second = fakeBot();
    const time = fakeTime();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    const supervisor = supervise(body, async () => session(second), {
      now: time.now,
      sleep: time.sleep,
    });

    // Both the supervisor and the accessor typecheck as a LifecycleSource.
    const source: LifecycleSource = supervisor;
    const viaAccessor: LifecycleSource | undefined = body.lifecycle;
    expect(viaAccessor).toBe(supervisor);

    const generations: (number | undefined)[] = [];
    const unsubscribe = source.on((event) => {
      if (event.kind === 'reconnected') generations.push(event.generation);
    });

    first.emit('end');
    await settle();
    expect(generations).toEqual([2]);

    unsubscribe();
    second.emit('end');
    await settle();
    expect(generations).toEqual([2]);
  });

  it('is a SessionSupervisor, so a caller can still ask about the body', () => {
    const first = fakeBot();
    const body = new MineflayerEmbodiment(first.bot, vec3, goals);
    supervise(body, async () => session(fakeBot()));
    expect(body.lifecycle).toBeInstanceOf(SessionSupervisor);
    expect(body.lifecycle?.status).toBe('alive');
  });
});
