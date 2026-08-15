import { describe, expect, it } from 'vitest';

import {
  EVENT_BUFFER_LIMIT,
  FakeWorld,
  createFakeEmbodiment,
} from '../../src/embodiment/fake/index.js';
import type { MineflayerBotLike } from '../../src/embodiment/mineflayer/index.js';
import {
  MINEFLAYER_EVENT_BUFFER_LIMIT,
  MineflayerSensorPort,
} from '../../src/embodiment/mineflayer/index.js';

describe('fake sound and chat events', () => {
  it('drains sounds once and only once', () => {
    const world = new FakeWorld();
    const { sensors } = createFakeEmbodiment(world);
    world.emitSound('entity.creeper.primed', { x: 4, y: 64, z: 0 }, 1);

    const first = sensors.drainSounds();
    expect(first).toHaveLength(1);
    expect(first[0]?.name).toBe('entity.creeper.primed');
    // A sound is an event, not a state: it is not still there afterwards.
    expect(sensors.drainSounds()).toHaveLength(0);
  });

  it('drains chat once and only once, keeping whisper apart from broadcast', () => {
    const world = new FakeWorld();
    const { sensors } = createFakeEmbodiment(world);
    world.emitChat('Alex', 'diamonds at 12 -54 88');
    world.emitChat('Steve', 'meet me at spawn', { private: true });

    const drained = sensors.drainChat();
    expect(drained.map((m) => m.from)).toEqual(['Alex', 'Steve']);
    expect(drained[0]?.private).toBe(false);
    expect(drained[1]?.private).toBe(true);
    expect(sensors.drainChat()).toHaveLength(0);
  });

  it('bounds both buffers, dropping the oldest events', () => {
    const world = new FakeWorld();
    for (let i = 0; i < EVENT_BUFFER_LIMIT * 3; i += 1) {
      world.emitSound(`sound_${i}`, { x: 0, y: 64, z: 0 });
      world.emitChat('Alex', `line ${i}`);
    }
    expect(world.pendingEvents()).toEqual({
      sounds: EVENT_BUFFER_LIMIT,
      chat: EVENT_BUFFER_LIMIT,
    });

    const sounds = world.drainSounds();
    const chat = world.drainChat();
    expect(sounds[0]?.name).toBe(`sound_${EVENT_BUFFER_LIMIT * 2}`);
    expect(chat[0]?.text).toBe(`line ${EVENT_BUFFER_LIMIT * 2}`);
    expect(world.pendingEvents()).toEqual({ sounds: 0, chat: 0 });
  });
});

/** Just enough bot to exercise the event subscriptions offline. */
function stubBot(): {
  readonly bot: MineflayerBotLike;
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
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
    once(): void {
      // Nothing here waits for a one-shot event.
    },
  } as unknown as MineflayerBotLike;

  return {
    bot,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

const vec3 = (x: number, y: number, z: number) => ({ x, y, z });

describe('mineflayer sound and chat buffering', () => {
  it('buffers named sounds, hardcoded sounds, chat and whispers', () => {
    const { bot, emit } = stubBot();
    const sensors = new MineflayerSensorPort(bot, vec3);

    emit(
      'soundEffectHeard',
      'minecraft:entity.zombie.ambient',
      { x: 4, y: 64, z: 2 },
      0.8,
    );
    emit('hardcodedSoundEffectHeard', 17, 3, { x: -2, y: 60, z: 0 }, 1);
    emit('chat', 'Alex', 'iron over here');
    emit('whisper', 'Steve', 'do not tell Alex');

    const sounds = sensors.drainSounds();
    expect(sounds.map((s) => s.name)).toEqual([
      'entity.zombie.ambient',
      'hardcoded_17',
    ]);
    expect(sounds[0]?.volume).toBe(0.8);
    expect(sounds[0]?.approximatePosition).toEqual({ x: 4, y: 64, z: 2 });

    const chat = sensors.drainChat();
    expect(chat).toEqual([
      { from: 'Alex', text: 'iron over here', private: false },
      { from: 'Steve', text: 'do not tell Alex', private: true },
    ]);

    expect(sensors.drainSounds()).toHaveLength(0);
    expect(sensors.drainChat()).toHaveLength(0);
  });

  it('drops events it cannot make sense of rather than guessing', () => {
    const { bot, emit } = stubBot();
    const sensors = new MineflayerSensorPort(bot, vec3);

    emit('soundEffectHeard', 'no.position.here', undefined, 1);
    emit(
      'hardcodedSoundEffectHeard',
      'not a number',
      0,
      { x: 0, y: 0, z: 0 },
      1,
    );
    emit('chat', 'Alex', { toString: () => 'an object, not a string' });

    expect(sensors.drainSounds()).toHaveLength(0);
    expect(sensors.drainChat()).toHaveLength(0);
  });

  it('bounds its buffers so a long session cannot grow without limit', () => {
    const { bot, emit } = stubBot();
    const sensors = new MineflayerSensorPort(bot, vec3);

    for (let i = 0; i < MINEFLAYER_EVENT_BUFFER_LIMIT * 2; i += 1) {
      emit('soundEffectHeard', `sound_${i}`, { x: 0, y: 64, z: 0 }, 1);
      emit('chat', 'Alex', `line ${i}`);
    }

    const sounds = sensors.drainSounds();
    const chat = sensors.drainChat();
    expect(sounds).toHaveLength(MINEFLAYER_EVENT_BUFFER_LIMIT);
    expect(chat).toHaveLength(MINEFLAYER_EVENT_BUFFER_LIMIT);
    expect(sounds[0]?.name).toBe(`sound_${MINEFLAYER_EVENT_BUFFER_LIMIT}`);
    expect(chat[0]?.text).toBe(`line ${MINEFLAYER_EVENT_BUFFER_LIMIT}`);
  });
});
