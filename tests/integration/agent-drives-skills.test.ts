import { describe, expect, it } from 'vitest';
import { buildDigest } from '../../src/agent/observation-digest.js';
import type { Goal } from '../../src/agent/goal.js';
import {
  DEFAULT_RULE_SKILLS,
  RulePolicy,
  impliedBlockNames,
  type PolicyInput,
  type SkillDescriptor,
} from '../../src/agent/policy.js';
import { registerCoreSkills } from '../../src/skills/library/index.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { FakeWorld, block, entity, obs } from '../agent/support.js';

/**
 * The seam between the reference agent and the real skill library.
 *
 * Each layer was built against the shared contracts independently, so both
 * typecheck in isolation while still disagreeing about what a skill is called
 * and what arguments it takes. Only a test that crosses the boundary catches
 * that, and one did not exist until a flee call was found passing arguments
 * no schema would accept.
 */

const registry = new SkillRegistry();
registerCoreSkills(registry);

const catalogue: readonly SkillDescriptor[] = registry
  .list()
  .map((s) => ({ name: s.name, summary: s.summary }));

function goal(description: string): Goal {
  return { id: 'g1', description, status: 'active', createdAt: 0 };
}

function policyInput(
  world: FakeWorld,
  clock: ManualClock,
  description: string,
  skills: readonly SkillDescriptor[] = catalogue,
): PolicyInput {
  return {
    // Mirrors what AgentLoop does: the goal decides what the digest looks for.
    digest: buildDigest(world, clock.now(), {
      blockNames: impliedBlockNames(goal(description)),
    }),
    goal: goal(description),
    goals: [goal(description)],
    memory: { summary: undefined, turns: [], facts: [], locations: [] },
    skills,
    step: 0,
    stepBudget: 20,
    lastOutcome: undefined,
    signal: new AbortController().signal,
  };
}

/** Parse a decision's input with the registered skill's own schema. */
function validate(name: string, input: unknown) {
  const skill = registry.get(name);
  expect(skill, `no skill registered as "${name}"`).toBeDefined();
  return skill!.input.safeParse(input);
}

describe('the names RulePolicy reaches for exist in the library', () => {
  it.each(
    Object.entries(DEFAULT_RULE_SKILLS).filter(([role]) => role !== 'explore'),
  )('%s maps to a registered skill', (_role, name) => {
    expect(registry.has(name)).toBe(true);
  });

  it('explore is deliberately absent from the core library', () => {
    // Named so a deployment can supply one; the catalogue check must skip it
    // rather than emitting a call nothing can serve.
    expect(registry.has(DEFAULT_RULE_SKILLS.explore)).toBe(false);
  });
});

describe('decisions validate against the real skill schemas', () => {
  it('produces a collectBlock call the skill accepts', async () => {
    const clock = new ManualClock(1000);
    const world = new FakeWorld(clock);
    world.blocks = [obs(block('oak_log', { x: 3, y: 64, z: 0 }), 'sight', 1000)];

    const d = await new RulePolicy().decide(
      policyInput(world, clock, 'gather 3 oak_log'),
    );

    expect(d.kind).toBe('skill');
    if (d.kind !== 'skill') return;
    expect(d.name).toBe('collectBlock');

    const parsed = validate(d.name, d.input);
    expect(
      parsed.success,
      `collectBlock rejected ${JSON.stringify(d.input)}`,
    ).toBe(true);
  });

  it('produces a flee call the skill accepts', async () => {
    const clock = new ManualClock(1000);
    const world = new FakeWorld(clock);
    world.bodyState = { ...world.bodyState, health: 4 };
    world.entities = [
      obs(
        entity(7, 'zombie', { x: 2, y: 64, z: 0 }, { hostile: true }),
        'sight',
        1000,
      ),
    ];

    const d = await new RulePolicy().decide(
      policyInput(world, clock, 'gather 1 oak_log'),
    );

    expect(d.kind).toBe('skill');
    if (d.kind !== 'skill') return;
    expect(d.name).toBe('flee');

    const parsed = validate(d.name, d.input);
    expect(parsed.success, `flee rejected ${JSON.stringify(d.input)}`).toBe(
      true,
    );
  });

  it('produces a consumeItem call the skill accepts', async () => {
    const clock = new ManualClock(1000);
    const world = new FakeWorld(clock);
    world.bodyState = { ...world.bodyState, food: 3 };
    world.items = [{ name: 'bread', count: 2 }];

    const d = await new RulePolicy().decide(
      policyInput(world, clock, 'gather 1 oak_log'),
    );

    expect(d.kind).toBe('skill');
    if (d.kind !== 'skill') return;
    expect(d.name).toBe('consumeItem');

    const parsed = validate(d.name, d.input);
    expect(
      parsed.success,
      `consumeItem rejected ${JSON.stringify(d.input)}`,
    ).toBe(true);
  });
});

describe('the catalogue gates what the policy will emit', () => {
  it('does not emit a skill the catalogue does not offer', async () => {
    const clock = new ManualClock(1000);
    const world = new FakeWorld(clock);
    world.bodyState = { ...world.bodyState, food: 3 };
    world.items = [{ name: 'bread', count: 2 }];

    // An empty catalogue means "unknown", so pass one that is real but lacks
    // the eating skill.
    const withoutEating = catalogue.filter((s) => s.name !== 'consumeItem');
    const d = await new RulePolicy().decide(
      policyInput(world, clock, 'gather 1 oak_log', withoutEating),
    );

    if (d.kind === 'skill') expect(d.name).not.toBe('consumeItem');
  });

  it('every skill the library registers has an MCP-legal name', () => {
    // Tool names: 1-128 chars, only A-Za-z0-9_.- per the MCP specification.
    for (const name of registry.names()) {
      expect(name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });
});
