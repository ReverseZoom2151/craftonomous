import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { GoalStack } from '../../src/agent/goal.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { buildDigest } from '../../src/agent/observation-digest.js';
import { RulePolicy } from '../../src/agent/policy.js';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { RESOURCE_URIS } from '../../src/mcp/resources.js';
import { createServer } from '../../src/mcp/server.js';
import { PerceptionDenied } from '../../src/perception/gate.js';
import { FAIR_PLAY, XRAY } from '../../src/perception/profile.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';
import type { OfflineSession } from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * The project's central claim, checked across every layer at once.
 *
 * A block behind a wall must not reach an agent under `fair-play`; the same
 * block must reach it under `xray`; and a fact that has aged out of sight must
 * arrive in the agent's prompt tagged as a recollection with its age, never as
 * a present-tense fact. Each of those is tested somewhere in isolation. What is
 * tested here is that they survive the whole stack: sensor port, gate, memory,
 * adapter, skills, MCP resources, and the digest an agent actually reads.
 */

const FLOOR_Y = 63;
const ORE = { x: 6, y: 64, z: 0 };

/** A floor, a wall at x = 4, and one ore block behind it. */
function walledWorld(): FakeWorld {
  const world = new FakeWorld();
  world.fill(
    { x: -16, y: FLOOR_Y, z: -16 },
    { x: 16, y: FLOOR_Y, z: 16 },
    'stone',
  );
  world.fill({ x: 4, y: 64, z: -3 }, { x: 4, y: 66, z: 3 }, 'stone');
  world.setBlock(ORE, 'diamond_ore');
  return world;
}

interface Rig {
  readonly session: OfflineSession;
  readonly clock: ManualClock;
}

function rig(world: FakeWorld, profile: PerceptionProfile): Rig {
  const clock = new ManualClock(1_000);
  return {
    clock,
    session: createOfflineSession({
      world,
      profile,
      clock,
      autoStart: false,
      log: silentLogger,
    }),
  };
}

describe('a block behind a wall', () => {
  it('is not returned under fair-play, at any level of the stack', async () => {
    const { session, clock } = rig(walledWorld(), FAIR_PLAY);

    // The sensor port knows perfectly well the ore is there. That is the point:
    // the gate has to have something true to restrict.
    expect(session.body.world.getBlock(ORE)?.name).toBe('diamond_ore');

    expect(session.world.blockAt(ORE)).toBeUndefined();
    expect(
      session.world.findBlocks({ names: ['diamond_ore'], maxDistance: 64 }),
    ).toEqual([]);

    // A skill that wants the ore is told it is unknown, not that it is absent.
    const found = await session.invoker.run(
      'goToBlock',
      { name: 'diamond_ore', maxDistance: 32 },
      {
        world: session.world,
        act: session.act,
        clock,
        log: silentLogger,
        signal: new AbortController().signal,
      },
    );
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.kind).toBe('unreachable');
      expect(found.message).toContain('has not been sensed');
    }

    // And the digest an agent reads says nothing is known, rather than
    // fabricating an absence it never checked.
    const digest = buildDigest(session.world, clock.now(), {
      blockNames: ['diamond_ore'],
    });
    expect(digest.blocks).toEqual([]);
    expect(digest.text).toContain('none known');
  });

  it('is returned under xray, from the same world and the same wall', () => {
    const { session, clock } = rig(walledWorld(), XRAY);

    const seen = session.world.blockAt(ORE);
    expect(seen?.value.name).toBe('diamond_ore');
    expect(seen?.provenance).toBe('sight');

    const found = session.world.findBlocks({
      names: ['diamond_ore'],
      maxDistance: 64,
    });
    expect(found.map((b) => b.value.name)).toEqual(['diamond_ore']);

    const digest = buildDigest(session.world, clock.now(), {
      blockNames: ['diamond_ore'],
    });
    expect(digest.text).toContain('diamond_ore at (6,64,0)');
    // Seeing through a wall is not a privileged read: it is a stated profile,
    // and the digest says so where an agent will read it.
    expect(digest.text).toContain('sees through walls');
    expect(session.world.report().privileged).toBe(0);
  });
});

describe('a fact that has aged into memory', () => {
  it('reaches the prompt digest as a recollection with an age', () => {
    const world = new FakeWorld();
    world.fill(
      { x: -16, y: FLOOR_Y, z: -16 },
      { x: 16, y: FLOOR_Y, z: 16 },
      'stone',
    );
    world.setBlock({ x: 3, y: 64, z: 0 }, 'oak_log');

    const { session, clock } = rig(world, FAIR_PLAY);

    const sighted = session.world.blockAt({ x: 3, y: 64, z: 0 });
    expect(sighted?.provenance).toBe('sight');

    // The world moves on: a wall goes up between the agent and the log. The log
    // is still there, but the agent can no longer see it.
    world.fill({ x: 2, y: 64, z: -2 }, { x: 2, y: 65, z: 2 }, 'stone');
    clock.advance(120_000);

    const recalled = session.world.blockAt({ x: 3, y: 64, z: 0 });
    expect(recalled?.provenance).toBe('memory');
    expect(recalled?.sensedAt).toBe(1_000);

    const digest = buildDigest(session.world, clock.now(), {
      blockNames: ['oak_log'],
    });

    // The one thing the digest must never do: render this as a present fact.
    expect(digest.text).toContain('oak_log at (3,64,0) [remembered 2m ago]');
    expect(digest.text).not.toContain('oak_log at (3,64,0) [seen]');
    expect(digest.text).toContain(
      'Anything tagged [remembered] may no longer be true.',
    );
    expect(digest.blocks[0]?.provenance).toBe('memory');
    expect(session.world.report().counts.memory).toBeGreaterThan(0);
  });

  it('is forgotten outright once it passes the profile horizon', () => {
    const world = new FakeWorld();
    world.fill(
      { x: -16, y: FLOOR_Y, z: -16 },
      { x: 16, y: FLOOR_Y, z: 16 },
      'stone',
    );
    world.setBlock({ x: 3, y: 64, z: 0 }, 'oak_log');

    const { session, clock } = rig(world, FAIR_PLAY);
    session.world.blockAt({ x: 3, y: 64, z: 0 });

    world.fill({ x: 2, y: 64, z: -2 }, { x: 2, y: 65, z: 2 }, 'stone');
    clock.advance(FAIR_PLAY.memoryHorizonMs + 1_000);

    expect(session.world.blockAt({ x: 3, y: 64, z: 0 })).toBeUndefined();
    const digest = buildDigest(session.world, clock.now(), {
      blockNames: ['oak_log'],
    });
    expect(digest.blocks).toEqual([]);
  });
});

describe('no privileged read ever occurs under fair-play', () => {
  it('the gate refuses one outright rather than degrading quietly', () => {
    const { session } = rig(walledWorld(), FAIR_PLAY);

    expect(() => session.gate.sense({ x: 0 }, 'privileged')).toThrow(
      PerceptionDenied,
    );
    // The refusal is not recorded as a read: nothing was learned.
    expect(session.world.report().counts.privileged).toBe(0);
  });

  it('holds across an agent run, the ledger, and the MCP resource alike', async () => {
    const world = walledWorld();
    // Something the agent can legitimately reach, on its own side of the wall.
    world.setBlock({ x: -3, y: 64, z: 0 }, 'oak_log');
    world.setBlock({ x: -4, y: 64, z: 4 }, 'oak_log');

    const { session, clock } = rig(world, FAIR_PLAY);
    const goals = new GoalStack({ clock });
    goals.push('gather 2 oak_log');

    const trace = await new AgentLoop({
      world: session.world,
      invoker: session.invoker,
      policy: new RulePolicy(),
      clock,
      goals,
      skills: session.registry
        .list()
        .map((s) => ({ name: s.name, summary: s.summary })),
      maxSteps: 8,
      log: silentLogger,
    }).run();

    expect(trace.perception.total).toBeGreaterThan(0);
    expect(trace.perception.privileged).toBe(0);
    expect(trace.perception.privilegedShare).toBe(0);
    expect(trace.perception.fairPlay).toBe(true);

    // The agent walked around its own side of the world and never learned about
    // the ore, however much it read.
    expect(world.getBlock(ORE)?.name).toBe('diamond_ore');
    expect(
      session.world.findBlocks({ names: ['diamond_ore'], maxDistance: 64 }),
    ).toEqual([]);

    // The same ledger, served over MCP, says the same thing.
    const { server } = createServer({
      registry: session.registry,
      invoker: session.invoker,
      world: session.world,
      reliability: session.reliability,
      act: session.act,
      clock,
      log: silentLogger,
      profile: session.gate.profile,
    });
    const client = new Client({ name: 'provenance-audit', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const read = await client.readResource({ uri: RESOURCE_URIS.perception });
      const first = read.contents[0] as { readonly text?: string } | undefined;
      const body = JSON.parse(String(first?.text)) as Record<string, unknown>;

      expect(body['fairPlay']).toBe(true);
      expect(body['privileged']).toBe(0);
      expect(body['privilegedShare']).toBe(0);
      expect(body['profile']).toMatchObject({
        name: 'fair-play',
        requireLineOfSight: true,
        allowPrivileged: false,
      });

      // Every observation the surroundings resource publishes is fairly
      // obtained, and says so item by item rather than in aggregate.
      const around = await client.readResource({
        uri: RESOURCE_URIS.surroundings,
      });
      const aroundFirst = around.contents[0] as
        { readonly text?: string } | undefined;
      const surroundings = JSON.parse(String(aroundFirst?.text)) as {
        readonly knownBlocks: readonly { readonly fairPlay: boolean }[];
      };
      for (const block of surroundings.knownBlocks) {
        expect(block.fairPlay).toBe(true);
      }
    } finally {
      await client.close();
    }
  });
});
