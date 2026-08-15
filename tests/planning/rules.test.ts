import { describe, expect, it, vi } from 'vitest';
import type {
  Proposer,
  Refiner,
  RuleDraft,
  Transition,
} from '../../src/planning/rules.js';
import {
  RuleMiner,
  apply,
  condition,
  conditionId,
  contrastiveProposer,
  measure,
  prune,
  testCondition,
  toRule,
} from '../../src/planning/rules.js';

const CRAFT = 'craft_wooden_pickaxe';

/**
 * A small, fully determined log. Two things must be learned (a crafting table
 * has to be nearby, and three planks are needed) and one irrelevant fact
 * (sticks, constant everywhere) must not be.
 */
const log: readonly Transition[] = [
  {
    action: CRAFT,
    before: { table: true, planks: 3, sticks: 2 },
    after: { table: true, planks: 0, sticks: 0, pickaxe: 1 },
    succeeded: true,
  },
  {
    action: CRAFT,
    before: { table: true, planks: 5, sticks: 2 },
    after: { table: true, planks: 2, sticks: 0, pickaxe: 1 },
    succeeded: true,
  },
  {
    action: CRAFT,
    before: { table: false, planks: 3, sticks: 2 },
    after: { table: false, planks: 3, sticks: 2 },
    succeeded: false,
    failureReason: 'no crafting interface',
  },
  {
    action: CRAFT,
    before: { table: true, planks: 1, sticks: 2 },
    after: { table: true, planks: 1, sticks: 2 },
    succeeded: false,
    failureReason: 'missing ingredients',
  },
  {
    action: CRAFT,
    before: { table: false, planks: 0, sticks: 2 },
    after: { table: false, planks: 0, sticks: 2 },
    succeeded: false,
    failureReason: 'no crafting interface',
  },
];

const ids = (
  drafts: readonly { condition: unknown; action: string }[],
): string[] =>
  drafts
    .map((d) =>
      conditionId(d.action, d.condition as Parameters<typeof conditionId>[1]),
    )
    .sort();

describe('testCondition', () => {
  const state = { a: 1, b: 'x', c: false };
  it('handles every operator', () => {
    expect(testCondition(condition('a', 'gte', 1), state)).toBe(true);
    expect(testCondition(condition('a', 'gte', 2), state)).toBe(false);
    expect(testCondition(condition('a', 'lte', 1), state)).toBe(true);
    expect(testCondition(condition('b', 'eq', 'x'), state)).toBe(true);
    expect(testCondition(condition('b', 'eq', 'y'), state)).toBe(false);
    expect(testCondition(condition('b', 'ne', 'y'), state)).toBe(true);
    expect(testCondition(condition('c', 'eq', false), state)).toBe(true);
    expect(testCondition(condition('c', 'present'), state)).toBe(true);
    expect(testCondition(condition('zz', 'present'), state)).toBe(false);
    expect(testCondition(condition('zz', 'absent'), state)).toBe(true);
    expect(testCondition(condition('zz', 'ne', 1), state)).toBe(true);
  });

  it('treats a missing key as failing a numeric comparison', () => {
    expect(testCondition(condition('zz', 'gte', 0), state)).toBe(false);
    expect(testCondition(condition('b', 'gte', 0), state)).toBe(false);
  });

  it('writes a readable description', () => {
    expect(condition('planks', 'gte', 3).description).toBe('planks >= 3');
    expect(condition('table', 'present').description).toBe('table is known');
  });
});

describe('stage a: propose', () => {
  it('nominates the facts that separate failures from successes', async () => {
    const drafts = await contrastiveProposer({
      action: CRAFT,
      failures: log.filter((t) => !t.succeeded),
      successes: log.filter((t) => t.succeeded),
    });
    expect(ids(drafts)).toEqual([
      `${CRAFT}::planks:gte:3`,
      `${CRAFT}::table:eq:true`,
    ]);
    // `sticks` is constant across successes and failures alike, so it carries
    // no information and must not be proposed.
    expect(ids(drafts).some((id) => id.includes('sticks'))).toBe(false);
  });

  it('describes the effect from what the successes changed', async () => {
    const drafts = await contrastiveProposer({
      action: CRAFT,
      failures: log.filter((t) => !t.succeeded),
      successes: log.filter((t) => t.succeeded),
    });
    expect(drafts[0]?.effect).toBe('changes pickaxe, planks, sticks');
  });

  it('proposes nothing when nothing ever failed', async () => {
    expect(
      await contrastiveProposer({
        action: CRAFT,
        failures: [],
        successes: log.filter((t) => t.succeeded),
      }),
    ).toEqual([]);
  });

  it('falls back to negating a fact shared by every failure', async () => {
    const failures: Transition[] = [
      {
        action: 'mine_stone',
        before: { tool: 'hand', depth: 12 },
        after: { tool: 'hand', depth: 12 },
        succeeded: false,
      },
      {
        action: 'mine_stone',
        before: { tool: 'hand', depth: 40 },
        after: { tool: 'hand', depth: 40 },
        succeeded: false,
      },
    ];
    const drafts = await contrastiveProposer({
      action: 'mine_stone',
      failures,
      successes: [],
    });
    expect(ids(drafts)).toEqual(['mine_stone::tool:ne:hand']);
  });

  it('proposes presence when successes always knew a fact failures did not', async () => {
    const drafts = await contrastiveProposer({
      action: 'smelt',
      successes: [
        {
          action: 'smelt',
          before: { fuel: 'coal' },
          after: { fuel: 'coal' },
          succeeded: true,
        },
      ],
      failures: [{ action: 'smelt', before: {}, after: {}, succeeded: false }],
    });
    expect(ids(drafts)).toContain('smelt::fuel:present');
  });
});

describe('measure', () => {
  it('counts only the failures a violated precondition explains', () => {
    const m = measure(
      { action: CRAFT, condition: condition('planks', 'gte', 3), effect: '' },
      log,
    );
    expect(m.support).toBe(2);
    expect(m.confidence).toBe(1);
    expect(m.counterexamples).toBe(0);
    expect(m.explains).toEqual([3, 4]);
  });

  it('punishes a precondition that successes violate freely', () => {
    const m = measure(
      { action: CRAFT, condition: condition('planks', 'gte', 6), effect: '' },
      log,
    );
    // Violated by both successes and all three failures.
    expect(m.counterexamples).toBe(2);
    expect(m.confidence).toBeCloseTo(3 / 5);
  });

  it('scores an unviolated precondition at zero rather than one', () => {
    const m = measure(
      { action: CRAFT, condition: condition('sticks', 'gte', 0), effect: '' },
      log,
    );
    expect(m.support).toBe(0);
    expect(m.confidence).toBe(0);
  });

  it('ignores transitions belonging to another action', () => {
    const m = measure(
      { action: 'other', condition: condition('planks', 'gte', 3), effect: '' },
      log,
    );
    expect(m.support).toBe(0);
  });
});

describe('stage c: greedy maximum-coverage prune', () => {
  const draft = (c: Parameters<typeof toRule>[0]['condition']): RuleDraft => ({
    action: CRAFT,
    condition: c,
    effect: 'crafts a pickaxe',
  });

  it('keeps the two rules needed to explain every failure', () => {
    const r = prune(
      [
        draft(condition('table', 'eq', true)),
        draft(condition('planks', 'gte', 3)),
      ],
      log,
    );
    expect(r.covered).toBe(3);
    expect(r.coverable).toBe(3);
    expect(r.rules).toHaveLength(2);
  });

  it('prefers one rule that covers everything over two that partition it', () => {
    // A log where a single precondition explains all three failures, and a pair
    // of narrower ones partitions the same three between them.
    const wide: readonly Transition[] = [
      {
        action: 'A',
        before: { p: 1, q: false, r: true },
        after: {},
        succeeded: false,
      },
      {
        action: 'A',
        before: { p: 2, q: false, r: true },
        after: {},
        succeeded: false,
      },
      {
        action: 'A',
        before: { p: 3, q: true, r: false },
        after: {},
        succeeded: false,
      },
      {
        action: 'A',
        before: { p: 9, q: true, r: true },
        after: {},
        succeeded: true,
      },
    ];
    const mk = (c: Parameters<typeof toRule>[0]['condition']): RuleDraft => ({
      action: 'A',
      condition: c,
      effect: 'e',
    });
    const broad = mk(condition('p', 'gte', 9));
    const narrowA = mk(condition('q', 'eq', true));
    const narrowB = mk(condition('r', 'eq', true));

    const withBroad = prune([narrowA, broad, narrowB], wide);
    expect(withBroad.rules.map((x) => x.id)).toEqual(['A::p:gte:9']);
    expect(withBroad.covered).toBe(3);

    // Without it, greedy needs both narrow rules to reach the same coverage,
    // which is the sense in which the selected set is minimal.
    const withoutBroad = prune([narrowA, narrowB], wide);
    expect(withoutBroad.rules).toHaveLength(2);
    expect(withoutBroad.covered).toBe(3);
  });

  it('drops candidates below the confidence floor', () => {
    const junk = draft(condition('planks', 'gte', 6)); // confidence 0.6
    expect(prune([junk], log, { minConfidence: 0.9 }).rules).toEqual([]);
    expect(prune([junk], log, { minConfidence: 0.5 }).rules).toHaveLength(1);
  });

  it('drops candidates below the support floor', () => {
    const thin = draft(condition('table', 'eq', true)); // support 2
    expect(prune([thin], log, { minSupport: 3 }).rules).toEqual([]);
    expect(prune([thin], log, { minSupport: 2 }).rules).toHaveLength(1);
  });

  it('honours maxRules and reports partial coverage honestly', () => {
    const r = prune(
      [
        draft(condition('table', 'eq', true)),
        draft(condition('planks', 'gte', 3)),
      ],
      log,
      { maxRules: 1 },
    );
    expect(r.rules).toHaveLength(1);
    expect(r.covered).toBe(2);
    expect(r.coverable).toBe(3);
  });

  it('stops early at a coverage target', () => {
    const r = prune(
      [
        draft(condition('table', 'eq', true)),
        draft(condition('planks', 'gte', 3)),
      ],
      log,
      { targetCoverage: 0.5 },
    );
    expect(r.rules).toHaveLength(1);
    expect(r.covered).toBe(2);
  });

  it('is deterministic: ties break the same way every time', () => {
    const candidates = [
      draft(condition('table', 'eq', true)),
      draft(condition('planks', 'gte', 3)),
    ];
    const a = prune(candidates, log).rules.map((x) => x.id);
    const b = prune([...candidates].reverse(), log).rules.map((x) => x.id);
    expect(a).toEqual(b);
  });

  it('returns nothing for an empty candidate set or an empty log', () => {
    expect(prune([], log).rules).toEqual([]);
    expect(prune([draft(condition('table', 'eq', true))], []).rules).toEqual(
      [],
    );
  });
});

describe('RuleMiner pipeline', () => {
  it('learns the crafting-table and plank preconditions end to end', async () => {
    const report = await new RuleMiner().mine(log);
    expect(report.rules.map((r) => r.id).sort()).toEqual([
      `${CRAFT}::planks:gte:3`,
      `${CRAFT}::table:eq:true`,
    ]);
    expect(report.covered).toBe(3);
    expect(report.coverable).toBe(3);
    expect(report.rules.every((r) => r.confidence === 1)).toBe(true);
  });

  it('uses the injected proposer and refiner, so a model can replace them', async () => {
    const proposer = vi.fn<Proposer>(({ action }) =>
      Promise.resolve([
        {
          action,
          condition: condition('table', 'eq', true),
          effect: 'crafts a pickaxe',
        },
        // A hallucinated rule: the log shows it violated by two successes and
        // only one failure, so the pure stage must throw it away regardless of
        // how confident the model sounded.
        {
          action,
          condition: condition('table', 'eq', false),
          effect: 'nonsense',
        },
      ]),
    );
    const refiner = vi.fn<Refiner>((drafts) => drafts);
    const report = await new RuleMiner({ proposer, refiner }).mine(log);

    expect(proposer).toHaveBeenCalledTimes(1);
    expect(proposer.mock.calls[0]?.[0].failures).toHaveLength(3);
    expect(proposer.mock.calls[0]?.[0].successes).toHaveLength(2);
    expect(refiner).toHaveBeenCalledTimes(1);
    expect(report.proposed).toBe(2);
    expect(report.rules.map((r) => r.id)).toEqual([`${CRAFT}::table:eq:true`]);
  });

  it('generalises a family of numeric thresholds down to one', async () => {
    const proposer: Proposer = ({ action }) =>
      [2, 3, 4, 6].map((n) => ({
        action,
        condition: condition('planks', 'gte', n),
        effect: 'crafts a pickaxe',
      }));
    const report = await new RuleMiner({ proposer }).mine(log);
    expect(report.proposed).toBe(4);
    expect(report.refined).toBe(1);
    // Thresholds 2 and 3 both explain every plank failure with no
    // counterexample; the tie goes to the more permissive one, because a
    // precondition that vetoes too much costs attempts that would have worked.
    expect(report.rules.map((r) => r.id)).toEqual([`${CRAFT}::planks:gte:2`]);
    expect(report.rules[0]?.confidence).toBe(1);
  });

  it('mines each action separately and skips actions that never failed', async () => {
    const mixed: Transition[] = [
      ...log,
      {
        action: 'walk',
        before: { blocked: false },
        after: { blocked: false },
        succeeded: true,
      },
    ];
    const report = await new RuleMiner().mine(mixed);
    expect(report.rules.every((r) => r.action === CRAFT)).toBe(true);
  });

  it('returns nothing from a log with no failures', async () => {
    const report = await new RuleMiner().mine(log.filter((t) => t.succeeded));
    expect(report.rules).toEqual([]);
    expect(report.proposed).toBe(0);
  });
});

describe('apply: vetoing an action before it fails', () => {
  it('blocks the action in a state that would have failed', async () => {
    const { rules } = await new RuleMiner().mine(log);
    const verdict = apply(rules, CRAFT, {
      table: false,
      planks: 5,
      sticks: 2,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.map((v) => v.id)).toEqual([
      `${CRAFT}::table:eq:true`,
    ]);
    expect(verdict.reason).toContain('table == true');
  });

  it('allows the action in a state matching the successes', async () => {
    const { rules } = await new RuleMiner().mine(log);
    const verdict = apply(rules, CRAFT, { table: true, planks: 3, sticks: 2 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.reason).toBe('');
  });

  it('reports every violated precondition, worst first', async () => {
    const { rules } = await new RuleMiner().mine(log);
    const verdict = apply(rules, CRAFT, { table: false, planks: 0, sticks: 2 });
    expect(verdict.violations.map((v) => v.id).sort()).toEqual([
      `${CRAFT}::planks:gte:3`,
      `${CRAFT}::table:eq:true`,
    ]);
  });

  it('says nothing about actions it has learned nothing about', async () => {
    const { rules } = await new RuleMiner().mine(log);
    expect(apply(rules, 'walk', {}).allowed).toBe(true);
    expect(apply([], CRAFT, { table: false }).allowed).toBe(true);
  });

  it('reproduces the labels of the whole log it was mined from', async () => {
    const { rules } = await new RuleMiner().mine(log);
    for (const t of log) {
      expect(apply(rules, t.action, t.before).allowed).toBe(t.succeeded);
    }
  });
});
