import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeWorld } from '../../src/embodiment/fake/index.js';
import { createServer } from '../../src/mcp/server.js';
import { RESOURCE_URIS } from '../../src/mcp/resources.js';
import { createOfflineSession } from '../../src/runtime/bootstrap.js';
import type { OfflineSession } from '../../src/runtime/bootstrap.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { silentLogger } from '../../src/runtime/logger.js';

/**
 * The seam between the MCP surface and a real assembled body.
 *
 * `tests/mcp/server.test.ts` stands the server up over hand-written stub skills
 * and an `OfflineWorldView` that senses nothing, so it proves the wire format
 * and nothing about the body. Here the server is built over a real
 * `createOfflineSession`: the tools are the real `CORE_SKILLS`, the invoker is
 * the real supervised `SkillRunner`, and a tool call really moves a body in a
 * real `FakeWorld`.
 */

const FLOOR_Y = 63;

function floored(): FakeWorld {
  const world = new FakeWorld();
  world.fill(
    { x: -16, y: FLOOR_Y, z: -16 },
    { x: 16, y: FLOOR_Y, z: 16 },
    'stone',
  );
  return world;
}

interface Rig {
  readonly client: Client;
  readonly session: OfflineSession;
  readonly world: FakeWorld;
}

async function connected(world: FakeWorld = floored()): Promise<Rig> {
  const clock = new ManualClock(1_000);
  const session = createOfflineSession({
    world,
    clock,
    autoStart: false,
    log: silentLogger,
  });

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

  const client = new Client({ name: 'integration-agent', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, session, world };
}

/**
 * The structured envelope a tool result carries, as an agent would read it.
 *
 * Typed loosely because the SDK's `CallToolResult` is a union that still
 * carries a legacy `toolResult` shape with no `structuredContent` on it.
 */
function payload(result: unknown): Record<string, unknown> {
  const structured = (result as { readonly structuredContent?: unknown })
    .structuredContent;
  return (structured ?? {}) as Record<string, unknown>;
}

describe('the MCP surface over a real body', () => {
  it('lists every core skill as a tool with a usable input schema', async () => {
    const { client, session } = await connected();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toEqual([...session.registry.names()]);
      expect(names).toContain('collectBlock');
      // Sorted, because clients cache tool lists and models cache the prompt
      // prefix that contains them.
      expect(names).toEqual([...names].sort());

      const dig = tools.find((t) => t.name === 'digBlock');
      expect(dig?.inputSchema.type).toBe('object');
      expect(
        (dig?.inputSchema.properties as Record<string, unknown> | undefined)?.[
          'position'
        ],
      ).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('a chat tool call reaches the body', async () => {
    const { client, session } = await connected();
    try {
      const result = await client.callTool({
        name: 'sendChat',
        arguments: { message: 'body online' },
      });

      expect(result.isError).toBe(false);
      expect(payload(result)['ok']).toBe(true);
      expect(session.body.actuators.chatLog).toEqual(['body online']);
    } finally {
      await client.close();
    }
  });

  it('a dig tool call actually removes a block and yields its drop', async () => {
    const world = floored();
    world.setBlock({ x: 1, y: 64, z: 0 }, 'coal_ore');
    const { client } = await connected(world);
    try {
      const result = await client.callTool({
        name: 'digBlock',
        arguments: { position: { x: 1, y: 64, z: 0 }, expect: 'coal_ore' },
      });

      expect(result.isError).toBe(false);
      expect(world.getBlock({ x: 1, y: 64, z: 0 })?.name).toBe('air');
      expect(world.countItem('coal_ore')).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('a collect tool call moves the body and fills the inventory', async () => {
    const world = floored();
    world.setBlock({ x: 5, y: 64, z: 0 }, 'oak_log');
    world.setBlock({ x: 6, y: 64, z: 5 }, 'oak_log');
    const { client } = await connected(world);
    try {
      const result = await client.callTool({
        name: 'collectBlock',
        arguments: { name: 'oak_log', count: 2 },
      });

      expect(result.isError).toBe(false);
      expect(payload(result)['ok']).toBe(true);
      expect(world.countItem('oak_log')).toBe(2);
      expect(world.body().position.x).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('a failing skill comes back as a tool result carrying its failure kind', async () => {
    const { client, session } = await connected();
    try {
      // Nothing is carried, so the precondition refuses before acting.
      const result = await client.callTool({
        name: 'equipItem',
        arguments: { item: 'netherite_pickaxe' },
      });

      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({
        ok: false,
        skill: 'equipItem',
        kind: 'precondition',
        retryable: false,
      });
      // A failure is a result, not a protocol fault: the body never acted.
      expect(session.body.actuators.actionsOfKind('equip')).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('an unknown tool is a protocol error, unlike a failed skill', async () => {
    const { client } = await connected();
    try {
      await expect(
        client.callTool({ name: 'teleport', arguments: {} }),
      ).rejects.toThrow(/no skill named/);
    } finally {
      await client.close();
    }
  });

  it('invalid arguments fail as invalid-input rather than as a protocol error', async () => {
    const { client } = await connected();
    try {
      const result = await client.callTool({
        name: 'digBlock',
        arguments: { position: { x: 'over there', y: 64, z: 0 } },
      });

      expect(result.isError).toBe(true);
      expect(payload(result)['kind']).toBe('invalid-input');
    } finally {
      await client.close();
    }
  });

  it('the perception resource reports the provenance of the run so far', async () => {
    const world = floored();
    world.setBlock({ x: 1, y: 64, z: 0 }, 'coal_ore');
    const { client } = await connected(world);
    try {
      const before = await client.readResource({
        uri: RESOURCE_URIS.perception,
      });
      const emptyReport = readJson(before);
      expect(emptyReport['total']).toBe(0);

      await client.callTool({
        name: 'digBlock',
        arguments: { position: { x: 1, y: 64, z: 0 } },
      });

      const after = await client.readResource({
        uri: RESOURCE_URIS.perception,
      });
      const report = readJson(after);

      expect(report['profile']).toMatchObject({
        name: 'fair-play',
        requireLineOfSight: true,
        allowPrivileged: false,
      });
      expect(report['total']).toBeGreaterThan(0);
      expect(report['privileged']).toBe(0);
      expect(report['privilegedShare']).toBe(0);
      expect(report['fairPlay']).toBe(true);

      const counts = report['counts'] as Record<string, number>;
      expect(counts['sight']).toBeGreaterThan(0);
      expect(counts['proprioception']).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('the skills resource carries the reliability a tool call just earned', async () => {
    const { client } = await connected();
    try {
      await client.callTool({
        name: 'sendChat',
        arguments: { message: 'measured' },
      });

      const read = await client.readResource({ uri: RESOURCE_URIS.skills });
      const body = readJson(read);
      const skills = body['skills'] as readonly Record<string, unknown>[];
      const chat = skills.find((s) => s['name'] === 'sendChat');

      expect((chat?.['reliability'] as { attempts: number }).attempts).toBe(1);
      expect((chat?.['reliability'] as { successes: number }).successes).toBe(
        1,
      );
    } finally {
      await client.close();
    }
  });
});

/** Pull the single JSON body out of a resource read. */
function readJson(read: {
  readonly contents: readonly unknown[];
}): Record<string, unknown> {
  const first = read.contents[0] as { readonly text?: string } | undefined;
  return JSON.parse(String(first?.text)) as Record<string, unknown>;
}
