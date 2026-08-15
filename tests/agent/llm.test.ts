import { describe, expect, it } from 'vitest';
import { GoalStack } from '../../src/agent/goal.js';
import type { LanguageModel, LlmMessage } from '../../src/agent/llm.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  LlmPolicy,
  buildPrompt,
  parseDecision,
  toolSpecs,
} from '../../src/agent/llm.js';
import { AgentMemory } from '../../src/agent/memory.js';
import { buildDigest } from '../../src/agent/observation-digest.js';
import type { PolicyInput } from '../../src/agent/policy.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FakeWorld, block, obs } from './support.js';

function input(
  overrides: {
    goal?: string;
    skills?: readonly { name: string; summary: string }[];
  } = {},
): PolicyInput {
  const clock = new ManualClock(500_000);
  const world = new FakeWorld(clock);
  world.remembered = [
    obs(
      block('iron_ore', { x: 12, y: 40, z: -3 }),
      'memory',
      clock.now() - 240_000,
    ),
  ];
  const goals = new GoalStack({ clock });
  if (overrides.goal !== undefined) goals.push(overrides.goal);
  const memory = new AgentMemory({ clock });
  memory.append('user', 'find some iron');
  memory.learn('the cave to the east floods');
  memory.remember('base', { x: 0, y: 64, z: 0 });
  return {
    digest: buildDigest(world, clock.now()),
    goal: goals.current(),
    goals: goals.stack(),
    memory: memory.snapshot(),
    skills: overrides.skills ?? [
      { name: 'collect_block', summary: 'mine a block' },
    ],
    step: 2,
    stepBudget: 20,
    lastOutcome: { kind: 'spoke', text: 'on my way' },
    signal: new AbortController().signal,
  };
}

/** A model that says whatever it was told to say. No network, ever. */
class CannedModel implements LanguageModel {
  readonly seen: LlmMessage[][] = [];

  constructor(private readonly replies: readonly string[]) {}

  complete(messages: readonly LlmMessage[]): Promise<string> {
    this.seen.push([...messages]);
    return Promise.resolve(this.replies[this.seen.length - 1] ?? '');
  }
}

describe('buildPrompt', () => {
  it('carries the digest, goal, skills and memory, provenance intact', () => {
    const messages = buildPrompt(input({ goal: 'gather 3 iron_ore' }));

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(DEFAULT_SYSTEM_PROMPT);
    const user = messages[1]?.content ?? '';
    expect(user).toContain('iron_ore at (12,40,-3) [remembered 4m ago]');
    expect(user).toContain('CURRENT gather 3 iron_ore');
    expect(user).toContain('- collect_block: mine a block');
    expect(user).toContain('find some iron');
    expect(user).toContain('the cave to the east floods');
    expect(user).toContain('step 3 of 20');
    expect(user).toContain('said "on my way"');
  });

  it('tells the model that remembered facts are not current', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('[remembered Xm ago] is a memory');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('UNKNOWN');
  });

  it('turns skills into tool specs', () => {
    expect(
      toolSpecs([{ name: 'dig', summary: 'dig', description: 'dig down' }]),
    ).toEqual([{ name: 'dig', description: 'dig down' }]);
  });
});

describe('parseDecision', () => {
  it('parses a bare JSON decision', () => {
    expect(
      parseDecision('{"kind":"skill","name":"dig","input":{"depth":3}}'),
    ).toEqual({
      kind: 'skill',
      name: 'dig',
      input: { depth: 3 },
    });
  });

  it('parses JSON inside a fenced block with commentary around it', () => {
    const raw = [
      'Sure! Here is what I will do next.',
      '```json',
      '{"kind": "speak", "text": "heading east"}',
      '```',
      'Let me know if that works.',
    ].join('\n');

    expect(parseDecision(raw)).toEqual({ kind: 'speak', text: 'heading east' });
  });

  it('tolerates the shapes models reach for unprompted', () => {
    expect(parseDecision('{"tool":"dig","arguments":{"n":1}}')).toEqual({
      kind: 'skill',
      name: 'dig',
      input: { n: 1 },
    });
    expect(parseDecision('{"kind":"stop","reason":"done here"}')).toEqual({
      kind: 'done',
      reason: 'done here',
    });
    expect(parseDecision('{"action":"say","message":"hi"}')).toEqual({
      kind: 'speak',
      text: 'hi',
    });
  });

  it('degrades to a safe done instead of throwing on malformed output', () => {
    for (const raw of [
      '',
      '   ',
      'I am not going to answer that.',
      '{ this is not json',
      '{"kind":"skill"}',
      '[1,2,3]',
      '{"kind":"wander off"}',
      '{"kind":"skill","name":42}',
    ]) {
      const decision = parseDecision(raw);
      expect(decision.kind).toBe('done');
      if (decision.kind === 'done') {
        expect(decision.reason).toContain('could not parse');
      }
    }
  });

  it('rejects a skill outside the catalogue', () => {
    const decision = parseDecision(
      '{"kind":"skill","name":"nuke","input":{}}',
      {
        knownSkills: ['dig'],
      },
    );
    expect(decision.kind).toBe('done');
  });

  it('takes a caller-supplied fallback', () => {
    expect(
      parseDecision('nonsense', {
        fallback: { kind: 'speak', text: 'I did not understand myself' },
      }),
    ).toEqual({ kind: 'speak', text: 'I did not understand myself' });
  });

  it('does not throw on deeply nested or adversarial text', () => {
    expect(() => parseDecision('{'.repeat(500))).not.toThrow();
    expect(() => parseDecision(`{"a":"${'x'.repeat(5000)}"}`)).not.toThrow();
  });
});

describe('LlmPolicy', () => {
  it('turns a well-formed response into a decision', async () => {
    const model = new CannedModel([
      '{"kind":"skill","name":"collect_block","input":{"name":"iron_ore"}}',
    ]);
    const policy = new LlmPolicy({ model });

    expect(await policy.decide(input())).toEqual({
      kind: 'skill',
      name: 'collect_block',
      input: { name: 'iron_ore' },
    });
  });

  it('degrades to done when the model rambles', async () => {
    const policy = new LlmPolicy({
      model: new CannedModel(['I think we should probably go mining, right?']),
    });

    const decision = await policy.decide(input());
    expect(decision.kind).toBe('done');
  });

  it('refuses a hallucinated skill name', async () => {
    const policy = new LlmPolicy({
      model: new CannedModel(['{"kind":"skill","name":"teleport","input":{}}']),
    });

    expect((await policy.decide(input())).kind).toBe('done');
  });

  it('ends the episode cleanly when the provider throws', async () => {
    const policy = new LlmPolicy({
      model: {
        complete: () => Promise.reject(new Error('429 rate limited')),
      },
    });

    const decision = await policy.decide(input());
    expect(decision.kind).toBe('done');
    if (decision.kind === 'done') {
      expect(decision.reason).toContain('429 rate limited');
    }
  });

  it('reports every raw generation for tracing', async () => {
    const seen: string[] = [];
    const policy = new LlmPolicy({
      model: new CannedModel(['{"kind":"done","reason":"ok"}']),
      onResponse: (raw) => seen.push(raw),
    });

    await policy.decide(input());
    expect(seen).toEqual(['{"kind":"done","reason":"ok"}']);
  });
});
