import { describe, expect, it } from 'vitest';

import type {
  LifecycleEvent,
  MineflayerBotLike,
} from '../../src/embodiment/mineflayer/index.js';
import {
  DEFAULT_RECONNECT,
  JOIN_WINDOW_MS,
  JoinBudget,
  MAX_JOIN_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  SessionSupervisor,
  backoffDelay,
} from '../../src/embodiment/mineflayer/index.js';

/** A bot that only knows how to emit events and respawn. */
function stubBot(options: { readonly canRespawn?: boolean } = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  let respawns = 0;
  const bot = {
    entity: undefined,
    entities: {},
    inventory: { items: () => [], slots: [] },
    blockAt: () => null,
    findBlocks: () => [],
    on(event: string, listener: (...args: unknown[]) => void): void {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    once(): void {},
    ...(options.canRespawn === false
      ? {}
      : {
          respawn(): void {
            respawns += 1;
          },
        }),
  } as unknown as MineflayerBotLike;

  return {
    bot,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    get respawns(): number {
      return respawns;
    },
  };
}

/** A clock and a sleep that advances it, so no test waits five real seconds. */
function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function collect(supervisor: SessionSupervisor): LifecycleEvent[] {
  const seen: LifecycleEvent[] = [];
  supervisor.on((event) => seen.push(event));
  return seen;
}

describe('JoinBudget', () => {
  it('allows the Mojang limit and no more inside one window', () => {
    const budget = new JoinBudget();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) budget.record(i * 100);
    expect(budget.used(500)).toBe(MAX_JOIN_ATTEMPTS);
    expect(budget.waitFor(500)).toBeGreaterThan(0);
    expect(MAX_JOIN_ATTEMPTS).toBeLessThan(6);
  });

  it('frees a join once it falls out of the window', () => {
    const budget = new JoinBudget();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) budget.record(0);
    expect(budget.waitFor(0)).toBe(JOIN_WINDOW_MS);
    expect(budget.waitFor(JOIN_WINDOW_MS)).toBe(0);
    expect(budget.used(JOIN_WINDOW_MS)).toBe(0);
  });

  it('counts initial joins and reconnects against the same budget', () => {
    const shared = new JoinBudget();
    shared.record(0); // an initial join
    for (let i = 1; i < MAX_JOIN_ATTEMPTS; i += 1) shared.record(i * 10);
    expect(shared.waitFor(1_000)).toBeGreaterThan(0);
  });
});

describe('reconnect rate limiting', () => {
  it('never fits a reconnect schedule inside one thirty-second window', async () => {
    const time = fakeTime();
    const budget = new JoinBudget();
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: () => Promise.reject(new Error('server is down')),
      budget,
      now: time.now,
      sleep: time.sleep,
    });
    const events = collect(supervisor);

    stub.emit('end', 'socket closed');
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const attempts = events.filter((e) => e.kind === 'reconnecting');
    expect(attempts).toHaveLength(MAX_JOIN_ATTEMPTS);
    for (const attempt of attempts) {
      expect(attempt.kind === 'reconnecting' && attempt.delayMs).toBeGreaterThanOrEqual(
        MIN_RETRY_DELAY_MS,
      );
    }
    // Five joins inside thirty seconds is the limit; this schedule is slower.
    expect(time.now()).toBeGreaterThan(JOIN_WINDOW_MS);
    expect(budget.used(time.now())).toBeLessThanOrEqual(MAX_JOIN_ATTEMPTS);
    expect(events.at(-1)?.kind).toBe('reconnect-failed');
  });

  it('waits out the budget even when the backoff would allow a join', async () => {
    const time = fakeTime();
    const budget = new JoinBudget();
    // The account has already used its whole budget elsewhere, just now.
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) budget.record(0);
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: async () => stubBot().bot,
      budget,
      policy: { initialDelayMs: MIN_RETRY_DELAY_MS },
      now: time.now,
      sleep: time.sleep,
    });
    const events = collect(supervisor);

    stub.emit('end');
    await new Promise((resolve) => setImmediate(resolve));

    const first = events.find((e) => e.kind === 'reconnecting');
    expect(first?.kind === 'reconnecting' && first.delayMs).toBe(JOIN_WINDOW_MS);
    expect(events.some((e) => e.kind === 'reconnected')).toBe(true);
  });

  it('keeps the documented floor and cap rather than inventing new ones', () => {
    expect(backoffDelay(0, DEFAULT_RECONNECT)).toBe(MIN_RETRY_DELAY_MS);
    expect(DEFAULT_RECONNECT.maxAttempts).toBe(MAX_JOIN_ATTEMPTS);
  });
});

describe('intentional close', () => {
  it('does not reconnect after close(), however the session ends', async () => {
    const time = fakeTime();
    let rejoins = 0;
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: async () => {
        rejoins += 1;
        return stubBot().bot;
      },
      now: time.now,
      sleep: time.sleep,
    });
    const events = collect(supervisor);

    supervisor.close();
    stub.emit('end', 'quit');
    await new Promise((resolve) => setImmediate(resolve));

    expect(rejoins).toBe(0);
    expect(supervisor.closed).toBe(true);
    expect(events.filter((e) => e.kind === 'reconnecting')).toHaveLength(0);
    const disconnects = events.filter((e) => e.kind === 'disconnected');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]?.kind === 'disconnected' && disconnects[0].intentional).toBe(true);
  });

  it('treats a drop nobody asked for as unintentional and reconnects', async () => {
    const time = fakeTime();
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: async () => stubBot().bot,
      now: time.now,
      sleep: time.sleep,
    });
    const events = collect(supervisor);

    stub.emit('kicked', 'You have been idle');
    await new Promise((resolve) => setImmediate(resolve));

    const disconnected = events.find((e) => e.kind === 'disconnected');
    expect(disconnected?.kind === 'disconnected' && disconnected.intentional).toBe(false);
    expect(disconnected?.kind === 'disconnected' && disconnected.reason).toMatch(/idle/);
    expect(supervisor.generation).toBe(2);
  });

  it('notes an intentional disconnect made through the embodiment', async () => {
    const time = fakeTime();
    let rejoins = 0;
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: async () => {
        rejoins += 1;
        return stubBot().bot;
      },
      now: time.now,
      sleep: time.sleep,
    });

    supervisor.noteIntentionalDisconnect();
    stub.emit('end');
    await new Promise((resolve) => setImmediate(resolve));

    expect(rejoins).toBe(0);
  });
});

describe('reconnect consequences', () => {
  it('announces a new generation, which is the signal that memory is stale', async () => {
    const time = fakeTime();
    const stub = stubBot();
    const next = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      rejoin: async () => next.bot,
      now: time.now,
      sleep: time.sleep,
    });
    const events = collect(supervisor);

    stub.emit('end');
    await new Promise((resolve) => setImmediate(resolve));

    const reconnected = events.find((e) => e.kind === 'reconnected');
    expect(reconnected?.kind === 'reconnected' && reconnected.generation).toBe(2);
    expect(supervisor.bot).toBe(next.bot);

    // The new bot is watched too, so a second drop is handled the same way.
    next.emit('death');
    expect(supervisor.deaths).toBe(1);
  });
});

describe('death and respawn', () => {
  it('reports a death and waits, by default', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({ bot: stub.bot, now: () => 5 });
    const events = collect(supervisor);

    stub.emit('death');

    expect(supervisor.status).toBe('dead');
    expect(supervisor.deaths).toBe(1);
    expect(stub.respawns).toBe(0);
    expect(events).toEqual([{ kind: 'death', at: 5, deaths: 1 }]);
  });

  it('respawns on request, and reports being alive again', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({ bot: stub.bot, now: () => 0 });
    const events = collect(supervisor);

    stub.emit('death');
    expect(supervisor.requestRespawn().ok).toBe(true);
    expect(supervisor.status).toBe('respawning');
    expect(stub.respawns).toBe(1);

    stub.emit('respawn');
    expect(supervisor.status).toBe('alive');
    expect(events.map((e) => e.kind)).toEqual(['death', 'respawn-requested', 'respawned']);
  });

  it('reports the death first even when respawning automatically', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({
      bot: stub.bot,
      respawn: 'auto',
      now: () => 0,
    });
    const events = collect(supervisor);

    stub.emit('death');

    expect(events.map((e) => e.kind)).toEqual(['death', 'respawn-requested']);
    expect(stub.respawns).toBe(1);
  });

  it('refuses to respawn a body that is not dead', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({ bot: stub.bot });
    expect(supervisor.requestRespawn()).toEqual({
      ok: false,
      detail: 'body is alive, not dead',
    });
    expect(stub.respawns).toBe(0);
  });

  it('says so when the substrate cannot respawn, rather than hanging', () => {
    const stub = stubBot({ canRespawn: false });
    const supervisor = new SessionSupervisor({ bot: stub.bot });
    stub.emit('death');
    const outcome = supervisor.requestRespawn();
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/cannot respawn/);
    expect(supervisor.status).toBe('dead');
  });

  it('counts repeated deaths', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({ bot: stub.bot, respawn: 'auto' });
    for (let i = 0; i < 3; i += 1) {
      stub.emit('death');
      stub.emit('respawn');
    }
    expect(supervisor.deaths).toBe(3);
    expect(supervisor.status).toBe('alive');
  });

  it('refuses to respawn once the session is closed', () => {
    const stub = stubBot();
    const supervisor = new SessionSupervisor({ bot: stub.bot });
    stub.emit('death');
    supervisor.close();
    expect(supervisor.requestRespawn().ok).toBe(false);
  });
});
