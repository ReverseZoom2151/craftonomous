import { describe, expect, it } from 'vitest';
import {
  defineManifest,
  defineTask,
  findTask,
  hashManifest,
  requiredProfiles,
} from '../../src/eval/task.js';
import type { Task, TaskManifest } from '../../src/eval/task.js';
import {
  BUILTIN_SUITES,
  GATHERING_SUITE,
  REFUSAL_SUITE,
  suiteByName,
} from '../../src/eval/suites/index.js';

const SUITE_VERSION = '1.0.0';

function task(id: string, version = '1.0.0', impossible = false): Task {
  return defineTask(SUITE_VERSION, {
    id,
    title: id,
    description: id,
    version,
    tags: [],
    difficulty: 'easy',
    goal: `goal for ${id}`,
    budget: { maxSteps: 10, maxDurationMs: 1000 },
    profile: 'fair-play',
    impossible,
  });
}

function manifest(tasks: readonly Task[], name = 'demo'): TaskManifest {
  return defineManifest({
    name,
    version: SUITE_VERSION,
    description: 'demo suite',
    tasks,
  });
}

describe('hashManifest', () => {
  it('is stable across repeated calls', () => {
    const m = manifest([task('a'), task('b'), task('c')]);
    expect(hashManifest(m)).toBe(hashManifest(m));
  });

  it('is independent of task order', () => {
    const a = manifest([task('a'), task('b'), task('c')]);
    const b = manifest([task('c'), task('a'), task('b')]);
    expect(hashManifest(a)).toBe(hashManifest(b));
  });

  it('changes when a task version changes', () => {
    const before = manifest([task('a'), task('b', '1.0.0')]);
    const after = manifest([task('a'), task('b', '1.1.0')]);
    expect(hashManifest(after)).not.toBe(hashManifest(before));
  });

  it('changes when a task is added or removed', () => {
    const two = manifest([task('a'), task('b')]);
    const three = manifest([task('a'), task('b'), task('c')]);
    expect(hashManifest(two)).not.toBe(hashManifest(three));
  });

  it('changes when the manifest identity changes', () => {
    const tasks = [task('a'), task('b')];
    expect(hashManifest(manifest(tasks, 'one'))).not.toBe(
      hashManifest(manifest(tasks, 'two')),
    );
    const bumped = defineManifest({
      name: 'demo',
      version: '2.0.0',
      description: 'demo suite',
      tasks: tasks.map((t) => ({ ...t, suiteVersion: '2.0.0' })),
    });
    expect(hashManifest(bumped)).not.toBe(hashManifest(manifest(tasks)));
  });

  it('is not sensitive to fields that do not change what is measured', () => {
    const base = manifest([task('a'), task('b')]);
    const retitled = manifest([
      { ...task('a'), title: 'a much nicer title' },
      task('b'),
    ]);
    expect(hashManifest(retitled)).toBe(hashManifest(base));
  });
});

describe('defineTask', () => {
  it('rejects empty ids and versions', () => {
    expect(() => task('')).toThrow(/id/);
    expect(() => task('x', '')).toThrow(/version/);
  });

  it('rejects a non-positive budget', () => {
    expect(() =>
      defineTask(SUITE_VERSION, {
        ...task('x'),
        budget: { maxSteps: 0, maxDurationMs: 1000 },
      }),
    ).toThrow(RangeError);
  });
});

describe('defineManifest', () => {
  it('rejects duplicate task ids', () => {
    expect(() => manifest([task('a'), task('a')])).toThrow(/duplicate/);
  });

  it('rejects suite version drift', () => {
    const stray = defineTask('9.9.9', { ...task('a') });
    expect(() => manifest([stray])).toThrow(/suite version/);
  });
});

describe('builtin suites', () => {
  it('are well-formed and discoverable', () => {
    expect(BUILTIN_SUITES.length).toBeGreaterThanOrEqual(2);
    expect(suiteByName('gathering')).toBe(GATHERING_SUITE);
    expect(suiteByName('refusal')).toBe(REFUSAL_SUITE);
    expect(suiteByName('nope')).toBeUndefined();
  });

  it('name the profile every task must be run under', () => {
    for (const suite of BUILTIN_SUITES) {
      expect(requiredProfiles(suite).length).toBeGreaterThan(0);
      for (const t of suite.tasks) expect(t.profile).not.toBe('');
    }
  });

  it('gathering is entirely satisfiable and ladders upward', () => {
    expect(GATHERING_SUITE.tasks.every((t) => !t.impossible)).toBe(true);
    expect(findTask(GATHERING_SUITE, 'craft.stone-pickaxe')).toBeDefined();
  });

  it('refusal mixes satisfiable and unsatisfiable goals', () => {
    const impossible = REFUSAL_SUITE.tasks.filter((t) => t.impossible);
    const possible = REFUSAL_SUITE.tasks.filter((t) => !t.impossible);
    expect(impossible.length).toBeGreaterThan(0);
    expect(possible.length).toBeGreaterThan(0);
  });
});
