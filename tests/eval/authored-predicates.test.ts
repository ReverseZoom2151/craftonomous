import { describe, expect, it } from 'vitest';
import { BUILTIN_SUITES } from '../../src/eval/suites/index.js';
import { parseGoal, predicateFor } from '../../src/eval/goal-check.js';

/**
 * Every shipped task now carries an authored `goalPredicate` instead of
 * relying on its prose being parsed.
 *
 * The migration is only safe if the authored form means exactly what the prose
 * meant. A mistyped predicate would not fail loudly: the suite would keep
 * running and would quietly measure something else, which is the worst
 * outcome available to a benchmark. So this asserts the two agree, task by
 * task, and it stays useful afterwards as the check that a future edit to one
 * did not forget the other.
 */

const TASKS = BUILTIN_SUITES.flatMap((suite) =>
  suite.tasks.map((task) => [suite.name, task] as const),
);

describe('authored goal predicates', () => {
  it('covers every shipped task', () => {
    const missing = TASKS.filter(([, t]) => t.goalPredicate === undefined);
    expect(missing.map(([s, t]) => `${s}/${t.id}`)).toEqual([]);
  });

  it.each(TASKS.map(([suite, t]) => [`${suite}/${t.id}`, t] as const))(
    '%s means what its prose says',
    (_label, task) => {
      const parsed = parseGoal(task.goal);
      expect(
        parsed.ok,
        `prose no longer parses, so the two forms cannot be compared: ${task.goal}`,
      ).toBe(true);
      if (!parsed.ok) return;
      expect(task.goalPredicate).toEqual(parsed.predicate);
    },
  );

  it('prefers the authored predicate over the prose', () => {
    const [, task] = TASKS[0] as [string, (typeof TASKS)[number][1]];
    const resolved = predicateFor(task);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.predicate).toEqual(task.goalPredicate);
  });

  it('still lets a caller override an authored predicate', () => {
    const [, task] = TASKS[0] as [string, (typeof TASKS)[number][1]];
    const override = { kind: 'item-count', item: 'sentinel', count: 99 } as const;
    const resolved = predicateFor(task, { [task.id]: override });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.predicate).toEqual(override);
  });
});
