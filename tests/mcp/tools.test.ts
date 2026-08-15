import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import type {
  Skill,
  SkillContext,
  SkillResult,
} from '../../src/skills/types.js';
import { fail, succeed } from '../../src/skills/types.js';
import {
  WRAPPED_ARGUMENT_KEY,
  describeSkill,
  describeSkillTool,
  isValidToolName,
  toJsonSchema,
  toolDefinition,
} from '../../src/mcp/schema.js';
import type { SkillInvoker } from '../../src/mcp/tools.js';
import { ToolDispatcher, listTools } from '../../src/mcp/tools.js';

// A context the dispatcher only ever passes through. Nothing here is read by
// the code under test, so it is deliberately hollow.
const fakeContext = (signal: AbortSignal): SkillContext =>
  ({ signal }) as unknown as SkillContext;

function fakeSkill<I>(
  name: string,
  input: z.ZodType<I>,
  overrides: Partial<Skill<I, unknown>> = {},
): Skill<I, unknown> {
  return {
    name,
    summary: `${name} summary`,
    description: `${name} description. Do not use it when something else fits.`,
    input,
    output: z.unknown(),
    run: async () => succeed(null, 0),
    ...overrides,
  };
}

/** Answers with whatever it was told to, and records what it was asked. */
class FakeInvoker implements SkillInvoker {
  readonly calls: { name: string; input: unknown }[] = [];

  constructor(
    private readonly reply: (
      name: string,
      input: unknown,
    ) => SkillResult<unknown> | Promise<SkillResult<unknown>>,
  ) {}

  async run(
    name: string,
    input: unknown,
    _ctx: SkillContext,
  ): Promise<SkillResult<unknown>> {
    this.calls.push({ name, input });
    return this.reply(name, input);
  }
}

const moveSkill = fakeSkill(
  'move.to',
  z.object({
    x: z.number().describe('block x'),
    y: z.number(),
    z: z.number(),
    range: z.number().optional(),
  }),
  { timeoutMs: 30_000 },
);

const idleSkill = fakeSkill('idle', z.object({}));

const saySkill = fakeSkill('chat.say', z.string().min(1));

function registryOf(...skills: Skill<never, unknown>[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const skill of skills) registry.register(skill);
  return registry;
}

describe('tool list generation', () => {
  it('turns every registered skill into a tool', () => {
    const registry = registryOf(
      moveSkill as unknown as Skill<never, unknown>,
      idleSkill as unknown as Skill<never, unknown>,
    );
    const tools = listTools(registry);
    expect(tools.map((t) => t.name)).toEqual(['idle', 'move.to']);
  });

  it('returns tools in a deterministic order regardless of registration', () => {
    const a = listTools(
      registryOf(
        moveSkill as unknown as Skill<never, unknown>,
        idleSkill as unknown as Skill<never, unknown>,
        saySkill as unknown as Skill<never, unknown>,
      ),
    );
    const b = listTools(
      registryOf(
        saySkill as unknown as Skill<never, unknown>,
        moveSkill as unknown as Skill<never, unknown>,
        idleSkill as unknown as Skill<never, unknown>,
      ),
    );
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(a.map((t) => t.name)).toEqual(['chat.say', 'idle', 'move.to']);
  });

  it('combines summary and description so an agent can choose', () => {
    const description = describeSkill(moveSkill as unknown as Skill<never, unknown>);
    expect(description).toContain('move.to summary');
    expect(description).toContain('Do not use it when something else fits.');
  });

  it('rejects a skill name MCP would not accept as a tool name', () => {
    expect(isValidToolName('move.to')).toBe(true);
    expect(isValidToolName('move to')).toBe(false);
    expect(() =>
      describeSkillTool(
        fakeSkill('move to', z.object({})) as unknown as Skill<never, unknown>,
      ),
    ).toThrow(/legal MCP tool name/);
  });
});

describe('JSON Schema conversion', () => {
  it('converts a zod object into an object schema with its properties', () => {
    const tool = toolDefinition(moveSkill as unknown as Skill<never, unknown>);
    expect(tool.inputSchema.type).toBe('object');
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
      'x',
      'y',
      'z',
      'range',
    ]);
    expect(tool.inputSchema.required).toEqual(['x', 'y', 'z']);
  });

  it('emits no $schema or definitions block', () => {
    const schema = toJsonSchema(
      z.object({ inner: z.object({ deep: z.string() }) }),
    );
    expect(schema['$schema']).toBeUndefined();
    expect(schema['definitions']).toBeUndefined();
  });

  it('gives a no-argument skill a schema that accepts nothing', () => {
    const tool = toolDefinition(idleSkill as unknown as Skill<never, unknown>);
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.inputSchema['additionalProperties']).toBe(false);
  });

  it('wraps a non-object input so the root stays an object', () => {
    const definition = describeSkillTool(
      saySkill as unknown as Skill<never, unknown>,
    );
    expect(definition.wrapsArguments).toBe(true);
    expect(definition.tool.inputSchema.type).toBe('object');
    expect(definition.tool.inputSchema.required).toEqual([
      WRAPPED_ARGUMENT_KEY,
    ]);
  });
});

describe('dispatching a tool call', () => {
  it('returns structured content on success', async () => {
    const invoker = new FakeInvoker(() => succeed({ arrived: true }, 42));
    const dispatcher = new ToolDispatcher({
      registry: registryOf(moveSkill as unknown as Skill<never, unknown>),
      invoker,
      context: fakeContext,
    });

    const result = await dispatcher.call('move.to', { x: 1, y: 2, z: 3 });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      ok: true,
      skill: 'move.to',
      value: { arrived: true },
      durationMs: 42,
    });
    expect(invoker.calls).toEqual([
      { name: 'move.to', input: { x: 1, y: 2, z: 3 } },
    ]);
  });

  it('unwraps arguments for a skill whose input is not an object', async () => {
    const invoker = new FakeInvoker(() => succeed(null, 1));
    const dispatcher = new ToolDispatcher({
      registry: registryOf(saySkill as unknown as Skill<never, unknown>),
      invoker,
      context: fakeContext,
    });

    await dispatcher.call('chat.say', { [WRAPPED_ARGUMENT_KEY]: 'hello' });

    expect(invoker.calls[0]?.input).toBe('hello');
  });

  it('surfaces the failure kind and the retryable flag', async () => {
    const invoker = new FakeInvoker(() =>
      fail('unreachable', 'no path to (10, 64, 10)', 900),
    );
    const dispatcher = new ToolDispatcher({
      registry: registryOf(moveSkill as unknown as Skill<never, unknown>),
      invoker,
      context: fakeContext,
    });

    const result = await dispatcher.call('move.to', { x: 10, y: 64, z: 10 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      skill: 'move.to',
      kind: 'unreachable',
      retryable: true,
      message: 'no path to (10, 64, 10)',
      durationMs: 900,
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain('unreachable');
    expect(text).toContain('retryable');
  });

  it('marks a precondition failure as not retryable', async () => {
    const invoker = new FakeInvoker(() =>
      fail('precondition', 'no pickaxe in inventory', 3),
    );
    const dispatcher = new ToolDispatcher({
      registry: registryOf(moveSkill as unknown as Skill<never, unknown>),
      invoker,
      context: fakeContext,
    });

    const result = await dispatcher.call('move.to', { x: 0, y: 0, z: 0 });

    expect(result.structuredContent).toMatchObject({
      kind: 'precondition',
      retryable: false,
    });
  });

  it('raises a protocol error for a tool that does not exist', async () => {
    const dispatcher = new ToolDispatcher({
      registry: registryOf(moveSkill as unknown as Skill<never, unknown>),
      invoker: new FakeInvoker(() => succeed(null, 0)),
      context: fakeContext,
    });

    await expect(dispatcher.call('fly.to.moon', {})).rejects.toBeInstanceOf(
      McpError,
    );
  });

  it('turns a thrown runner error into a tool result, not a crash', async () => {
    const dispatcher = new ToolDispatcher({
      registry: registryOf(moveSkill as unknown as Skill<never, unknown>),
      invoker: new FakeInvoker(() => {
        throw new Error('the runner exploded');
      }),
      context: fakeContext,
    });

    const result = await dispatcher.call('move.to', { x: 0, y: 0, z: 0 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: 'unknown',
      message: 'the runner exploded',
    });
  });
});
