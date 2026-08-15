import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import type { Skill, SkillContext } from '../../src/skills/types.js';
import { succeed } from '../../src/skills/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import { OfflineWorldView } from '../../src/mcp/offline.js';
import { createServer } from '../../src/mcp/server.js';
import type { RateLimitRule } from '../../src/mcp/rate-limit.js';
import {
  DEFAULT_GLOBAL_RULE,
  DEFAULT_PER_TOOL_RULE,
  RateLimiter,
} from '../../src/mcp/rate-limit.js';
import type { SkillInvoker } from '../../src/mcp/tools.js';
import { ToolDispatcher } from '../../src/mcp/tools.js';

const fakeContext = (signal: AbortSignal): SkillContext =>
  ({ signal }) as unknown as SkillContext;

/** Counts what actually reached the skill layer, which is the whole point. */
class CountingInvoker implements SkillInvoker {
  calls = 0;

  async run(_name: string, _input: unknown, _ctx: SkillContext) {
    this.calls += 1;
    return succeed({ done: true }, 1);
  }
}

function skill(name: string): Skill<never, unknown> {
  return {
    name,
    summary: `${name} summary`,
    description: `${name} description.`,
    input: z.object({}),
    output: z.unknown(),
    run: async () => succeed(null, 0),
  } as unknown as Skill<never, unknown>;
}

function registryOf(...names: string[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const name of names) registry.register(skill(name));
  return registry;
}

interface Harness {
  readonly dispatcher: ToolDispatcher;
  readonly clock: ManualClock;
  readonly invoker: CountingInvoker;
}

function harness(
  rules: { global?: RateLimitRule; perTool?: RateLimitRule } = {},
  names: string[] = ['move.wander', 'chat.say'],
): Harness {
  const clock = new ManualClock(1_000);
  const invoker = new CountingInvoker();
  const limiter = new RateLimiter({
    global: rules.global ?? { limit: 100, windowMs: 60_000 },
    perTool: rules.perTool ?? { limit: 100, windowMs: 60_000 },
    clock,
  });
  const dispatcher = new ToolDispatcher({
    registry: registryOf(...names),
    invoker,
    context: fakeContext,
    limiter,
  });
  return { dispatcher, clock, invoker };
}

function textOf(result: { content: unknown }): string {
  const first = (result.content as { type: string; text: string }[])[0];
  return first?.text ?? '';
}

describe('the documented defaults', () => {
  it('budgets a minute at a time, with the per-tool share smaller', () => {
    expect(DEFAULT_GLOBAL_RULE).toEqual({ limit: 30, windowMs: 60_000 });
    expect(DEFAULT_PER_TOOL_RULE).toEqual({ limit: 10, windowMs: 60_000 });
    expect(DEFAULT_PER_TOOL_RULE.limit).toBeLessThan(DEFAULT_GLOBAL_RULE.limit);
  });

  it('is what a limiter reports when nothing is configured', () => {
    const limiter = new RateLimiter({ clock: new ManualClock() });
    expect(limiter.globalRule).toEqual(DEFAULT_GLOBAL_RULE);
    expect(limiter.perToolRule).toEqual(DEFAULT_PER_TOOL_RULE);
  });

  it('refuses a nonsensical budget rather than serving an unbounded one', () => {
    expect(
      () => new RateLimiter({ global: { limit: 0, windowMs: 1000 } }),
    ).toThrow(RangeError);
    expect(
      () => new RateLimiter({ perTool: { limit: 5, windowMs: 0 } }),
    ).toThrow(RangeError);
  });
});

describe('enforcing the budget at the dispatch choke point', () => {
  it('lets a burst within the limit through untouched', async () => {
    const { dispatcher, invoker } = harness({
      perTool: { limit: 3, windowMs: 60_000 },
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await dispatcher.call('move.wander', {});
      expect(result.isError).toBe(false);
    }
    expect(invoker.calls).toBe(3);
  });

  it('refuses the call past the limit before the invoker runs', async () => {
    const { dispatcher, invoker } = harness({
      perTool: { limit: 3, windowMs: 60_000 },
    });

    for (let i = 0; i < 3; i += 1) await dispatcher.call('move.wander', {});
    const refused = await dispatcher.call('move.wander', {});

    expect(refused.isError).toBe(true);
    expect(invoker.calls).toBe(3);
  });

  it('refuses with a result, not a thrown protocol error', async () => {
    const { dispatcher } = harness({ perTool: { limit: 1, windowMs: 60_000 } });
    await dispatcher.call('move.wander', {});

    const refused = await dispatcher.call('move.wander', {});

    expect(refused).toBeDefined();
    expect(refused).not.toBeInstanceOf(McpError);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      ok: false,
      skill: 'move.wander',
      retryable: true,
    });
    // The contrast: an unknown tool really is a protocol error.
    await expect(dispatcher.call('teleport', {})).rejects.toBeInstanceOf(
      McpError,
    );
  });

  it('names a retry time so the model can wait instead of hammering', async () => {
    const { dispatcher, clock } = harness({
      perTool: { limit: 2, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});
    await dispatcher.call('move.wander', {});

    const refused = await dispatcher.call('move.wander', {});

    // Two per ten seconds is one token every five.
    expect(refused.structuredContent).toMatchObject({ retryAfterMs: 5_000 });
    const text = textOf(refused);
    expect(text).toContain('rate limited');
    expect(text).toContain('Retry after 5000ms');
    expect(text).toContain(`t=${clock.now() + 5_000}`);
  });

  it('says which budget ran out', async () => {
    const global = harness({ global: { limit: 1, windowMs: 60_000 } });
    await global.dispatcher.call('move.wander', {});
    expect(textOf(await global.dispatcher.call('move.wander', {}))).toContain(
      'global tool-call budget',
    );

    const perTool = harness({ perTool: { limit: 1, windowMs: 60_000 } });
    await perTool.dispatcher.call('move.wander', {});
    expect(textOf(await perTool.dispatcher.call('move.wander', {}))).toContain(
      'per-tool budget for "move.wander"',
    );
  });
});

describe('refilling as the clock advances', () => {
  it('grants a call again once enough time has passed', async () => {
    const { dispatcher, clock, invoker } = harness({
      perTool: { limit: 2, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});
    await dispatcher.call('move.wander', {});
    expect((await dispatcher.call('move.wander', {})).isError).toBe(true);

    // A shade under one token's worth is still not enough.
    clock.advance(4_999);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(true);

    clock.advance(1);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect(invoker.calls).toBe(3);
  });

  it('refills no further than the burst it started with', async () => {
    const { dispatcher, clock, invoker } = harness({
      perTool: { limit: 2, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});

    // An hour of idleness does not bank an hour of calls.
    clock.advance(3_600_000);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(true);
    expect(invoker.calls).toBe(3);
  });

  it('does not mint tokens when the clock goes backwards', async () => {
    const { dispatcher, clock } = harness({
      perTool: { limit: 1, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});

    clock.set(0);

    expect((await dispatcher.call('move.wander', {})).isError).toBe(true);
  });
});

describe('the two budgets against each other', () => {
  it('a per-tool limit does not block a different tool', async () => {
    const { dispatcher, invoker } = harness({
      global: { limit: 100, windowMs: 60_000 },
      perTool: { limit: 1, windowMs: 60_000 },
    });

    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(true);

    // The expensive skill starved itself, not the body.
    expect((await dispatcher.call('chat.say', {})).isError).toBe(false);
    expect(invoker.calls).toBe(2);
  });

  it('the global limit does block a different tool', async () => {
    const { dispatcher, invoker } = harness({
      global: { limit: 2, windowMs: 60_000 },
      perTool: { limit: 100, windowMs: 60_000 },
    });

    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);

    const refused = await dispatcher.call('chat.say', {});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('global tool-call budget');
    expect(invoker.calls).toBe(2);
  });

  it('a call refused by its tool budget does not spend a global token', async () => {
    const clock = new ManualClock(1_000);
    const limiter = new RateLimiter({
      global: { limit: 3, windowMs: 60_000 },
      perTool: { limit: 1, windowMs: 60_000 },
      clock,
    });

    expect(limiter.check('move.wander').allowed).toBe(true);
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.check('move.wander').allowed).toBe(false);
    }

    // Two global tokens should be left despite twenty refusals, and each of
    // them spendable by some other tool. (Each tool gets its own budget of
    // one, so this takes two different tools to demonstrate.)
    expect(limiter.check('chat.say').allowed).toBe(true);
    expect(limiter.check('craft.item').allowed).toBe(true);
    // Now the global budget really is spent.
    expect(limiter.check('look.around').allowed).toBe(false);
  });
});

describe('what a refusal costs', () => {
  it('does not consume budget, so the quoted retry time stays honest', async () => {
    const { dispatcher, clock, invoker } = harness({
      perTool: { limit: 1, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});

    const first = await dispatcher.call('move.wander', {});
    expect(first.structuredContent).toMatchObject({ retryAfterMs: 10_000 });

    // An agent that ignores the advice and hammers away gains nothing, and
    // more importantly loses nothing: the deadline does not move.
    for (let i = 0; i < 10; i += 1) {
      expect((await dispatcher.call('move.wander', {})).isError).toBe(true);
    }
    const last = await dispatcher.call('move.wander', {});
    expect(last.structuredContent).toMatchObject({ retryAfterMs: 10_000 });

    // Waiting exactly as long as it was first told is enough.
    clock.advance(10_000);
    expect((await dispatcher.call('move.wander', {})).isError).toBe(false);
    expect(invoker.calls).toBe(2);
  });

  it('counts down as the clock advances during a refusal', async () => {
    const { dispatcher, clock } = harness({
      perTool: { limit: 1, windowMs: 10_000 },
    });
    await dispatcher.call('move.wander', {});

    const before = await dispatcher.call('move.wander', {});
    clock.advance(4_000);
    const after = await dispatcher.call('move.wander', {});

    expect(before.structuredContent).toMatchObject({ retryAfterMs: 10_000 });
    expect(after.structuredContent).toMatchObject({ retryAfterMs: 6_000 });
  });
});

describe('configuring the limiter through createServer', () => {
  function server(rateLimit?: Parameters<typeof createServer>[0]['rateLimit']) {
    const invoker = new CountingInvoker();
    const clock = new ManualClock(1_000);
    const { tools } = createServer({
      registry: registryOf('move.wander', 'chat.say'),
      invoker,
      world: new OfflineWorldView(FAIR_PLAY),
      reliability: new ReliabilityTracker(),
      profile: FAIR_PLAY,
      clock,
      ...(rateLimit === undefined ? {} : { rateLimit }),
    });
    return { tools, invoker, clock };
  }

  it('limits by default, without anyone asking', async () => {
    const { tools, invoker } = server();

    for (let i = 0; i < DEFAULT_PER_TOOL_RULE.limit; i += 1) {
      expect((await tools.call('move.wander', {})).isError).toBe(false);
    }
    const refused = await tools.call('move.wander', {});

    expect(refused.isError).toBe(true);
    expect(invoker.calls).toBe(DEFAULT_PER_TOOL_RULE.limit);
  });

  it('takes overrides for either budget', async () => {
    const { tools } = server({ perTool: { limit: 1, windowMs: 60_000 } });

    expect((await tools.call('move.wander', {})).isError).toBe(false);
    expect((await tools.call('move.wander', {})).isError).toBe(true);
  });

  it('shares the server clock, so a manual clock drives the refills', async () => {
    const { tools, clock } = server({ perTool: { limit: 1, windowMs: 5_000 } });
    await tools.call('move.wander', {});
    expect((await tools.call('move.wander', {})).isError).toBe(true);

    clock.advance(5_000);

    expect((await tools.call('move.wander', {})).isError).toBe(false);
  });

  it('can be turned off, but only by saying so', async () => {
    const { tools, invoker } = server('off');

    for (let i = 0; i < DEFAULT_GLOBAL_RULE.limit * 3; i += 1) {
      expect((await tools.call('move.wander', {})).isError).toBe(false);
    }
    expect(invoker.calls).toBe(DEFAULT_GLOBAL_RULE.limit * 3);
  });
});
