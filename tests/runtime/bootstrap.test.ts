import { describe, expect, it } from 'vitest';
import type { CliConfig } from '../../src/cli/main.js';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import { CORE_SKILLS } from '../../src/skills/library/index.js';
import type { SkillContext } from '../../src/skills/types.js';
import {
  UnknownProfile,
  createOfflineSession,
  createSession,
  type OfflineSession,
} from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * The assembly layer, end to end, with no mineflayer and no network.
 *
 * Every layer below this was built and tested on its own, so each one passing
 * says nothing about whether they fit together. These tests only pass if a
 * session really does put sensors behind a gate, an adapter over the gate, a
 * runner over the skills and an actuator that changes a world.
 */

const STONE = { x: 1, y: 64, z: 0 };
// Off the line of sight to the stone, so neither block occludes the other.
const CHEST = { x: 0, y: 64, z: 2 };

function offline(): OfflineSession {
  const world = new FakeWorld();
  world.setBlock(STONE, 'stone', true);
  world.setBlock(CHEST, 'chest', true);
  world.setContainer(CHEST, 'chest', [{ name: 'iron_ingot', count: 3 }]);
  return createOfflineSession({
    world,
    clock: new ManualClock(1000),
    autoStart: false,
  });
}

/** What a caller hands the invoker. The session substitutes its own ports. */
function ctxFor(session: OfflineSession, signal?: AbortSignal): SkillContext {
  return {
    world: session.world,
    act: session.act,
    clock: session.clock,
    log: silentLogger,
    signal: signal ?? new AbortController().signal,
  };
}

describe('an offline session is a fully assembled body', () => {
  it('exposes a registry holding the core skills', () => {
    const session = offline();
    expect(session.registry.size).toBe(CORE_SKILLS.length);
    for (const skill of CORE_SKILLS) {
      expect(session.registry.has(skill.name)).toBe(true);
    }
  });

  it('hands out a world view and never a sensor port', () => {
    const session = offline();
    // The shape of the guarantee: everything a session exposes reads through
    // the gate, so there is no `sensors` handle to reach around it with.
    expect(
      (session as unknown as Record<string, unknown>)['sensors'],
    ).toBeUndefined();
    expect(session.world.profile.name).toBe(FAIR_PLAY.name);
    expect(session.gate.profile).toBe(session.world.profile);
  });

  it('runs a skill through the invoker that really moves the world', async () => {
    const session = offline();
    const result = await session.invoker.run(
      'digBlock',
      { position: STONE, expect: 'stone' },
      ctxFor(session),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(session.body.world.getBlock(STONE)?.name).toBe('air');
    expect(session.body.world.countItem('stone')).toBe(1);
    expect(session.body.actuators.actionsOfKind('dig')).toHaveLength(1);
  });

  it('records the run in the reliability tracker', async () => {
    const session = offline();
    await session.invoker.run('digBlock', { position: STONE }, ctxFor(session));
    const stats = session.reliability.stats('digBlock');
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
  });

  it('counts every read in the ledger and reports fair play', async () => {
    const session = offline();
    expect(session.gate.ledger.report().total).toBe(0);

    await session.invoker.run('digBlock', { position: STONE }, ctxFor(session));

    const report = session.world.report();
    expect(report.total).toBeGreaterThan(0);
    expect(report.counts.sight).toBeGreaterThan(0);
    expect(report.counts.proprioception).toBeGreaterThan(0);
    expect(report.privileged).toBe(0);
    expect(report.fairPlay).toBe(true);
    // One ledger, not two: the session's gate is the adapter's gate.
    expect(session.gate.ledger.report().total).toBe(report.total);
  });

  it('shows a container opened through the actuators in the world view', async () => {
    const session = offline();
    expect(session.world.openContainer()).toBeUndefined();

    const opened = await session.act.openContainer(CHEST);
    expect(opened?.kind).toBe('chest');

    const seen = session.world.openContainer();
    expect(seen?.value.kind).toBe('chest');
    expect(seen?.value.contents).toEqual([{ name: 'iron_ingot', count: 3 }]);
    expect(seen?.provenance).toBe('sight');

    await session.act.closeContainer();
    expect(session.world.openContainer()).toBeUndefined();
  });

  it('keeps a container open across a withdrawal, then lets it go', async () => {
    const session = offline();
    const result = await session.invoker.run(
      'withdrawItems',
      { position: CHEST, items: [{ name: 'iron_ingot', count: 2 }] },
      ctxFor(session),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(session.body.world.countItem('iron_ingot')).toBe(2);
    // The skill closes what it opened, so nothing is left open afterwards.
    expect(session.world.openContainer()).toBeUndefined();
  });

  it('closes down the body', async () => {
    const session = offline();
    expect(session.body.connected).toBe(true);
    await session.close?.();
    expect(session.body.connected).toBe(false);
  });
});

describe('createSession refuses a profile it does not know', () => {
  const config: CliConfig = {
    host: 'localhost',
    port: 25565,
    username: 'craftonomous',
    version: undefined,
    auth: 'offline',
    profile: { ...FAIR_PLAY, name: 'made-up' },
  };

  it('fails by name before it ever reaches for a body', async () => {
    // No mineflayer is loaded and no socket is opened: the profile is checked
    // first, so an unknown name is a clear error rather than a connection that
    // then dies for an unrelated reason.
    await expect(createSession(config)).rejects.toBeInstanceOf(UnknownProfile);
    await expect(createSession(config)).rejects.toThrow(/known profiles are/);
  });
});
