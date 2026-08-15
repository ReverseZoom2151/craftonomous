import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import type {
  Skill,
  SkillContext,
  SkillResult,
} from '../../src/skills/types.js';
import { fail, succeed } from '../../src/skills/types.js';
import { OfflineWorldView } from '../../src/mcp/offline.js';
import { createServer } from '../../src/mcp/server.js';
import type { SkillInvoker } from '../../src/mcp/tools.js';

class ScriptedInvoker implements SkillInvoker {
  async run(
    name: string,
    _input: unknown,
    _ctx: SkillContext,
  ): Promise<SkillResult<unknown>> {
    return name === 'chat.say'
      ? succeed({ said: true }, 5)
      : fail('timeout', 'took too long', 30_000);
  }
}

function saySkill(): Skill<never, unknown> {
  return {
    name: 'chat.say',
    summary: 'Say something in chat.',
    description: 'Broadcasts a message. Not for whispering.',
    input: z.object({ message: z.string() }),
    output: z.unknown(),
    run: async () => succeed(null, 0),
  } as unknown as Skill<never, unknown>;
}

function wanderSkill(): Skill<never, unknown> {
  return {
    name: 'move.wander',
    summary: 'Wander aimlessly.',
    description: 'Moves in no particular direction.',
    input: z.object({}),
    output: z.unknown(),
    run: async () => succeed(null, 0),
  } as unknown as Skill<never, unknown>;
}

async function connected() {
  const registry = new SkillRegistry();
  registry.register(saySkill());
  registry.register(wanderSkill());

  const { server } = createServer({
    registry,
    invoker: new ScriptedInvoker(),
    world: new OfflineWorldView(FAIR_PLAY),
    reliability: new ReliabilityTracker(),
    profile: FAIR_PLAY,
  });

  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe('the assembled MCP server', () => {
  it('lists skills as tools over the wire, sorted by name', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['chat.say', 'move.wander']);
    expect(tools[0]?.description).toContain('Not for whispering.');
    await client.close();
  });

  it('returns structured content for a successful call', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'chat.say',
      arguments: { message: 'hello' },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      skill: 'chat.say',
    });
    await client.close();
  });

  it('returns a tool error, not a protocol error, for a skill failure', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'move.wander',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    await client.close();
  });

  it('raises a protocol error for an unknown tool', async () => {
    const { client } = await connected();
    await expect(
      client.callTool({ name: 'teleport', arguments: {} }),
    ).rejects.toThrow(/no skill named/);
    await client.close();
  });

  it('serves the resource list and reads one', async () => {
    const { client } = await connected();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('craftonomous://perception');

    const read = await client.readResource({
      uri: 'craftonomous://perception',
    });
    const first = read.contents[0] as { text?: string } | undefined;
    const text = String(first?.text);
    expect(JSON.parse(text)).toMatchObject({
      profile: { name: 'fair-play' },
      fairPlay: true,
    });
    await client.close();
  });

  it('raises a protocol error for an unknown resource', async () => {
    const { client } = await connected();
    await expect(
      client.readResource({ uri: 'craftonomous://end-portal' }),
    ).rejects.toThrow(/no resource at/);
    await client.close();
  });
});
