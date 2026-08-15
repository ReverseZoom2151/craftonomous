/**
 * Satisfiable and unsatisfiable goals, mixed.
 *
 * Every surveyed benchmark asks only whether an agent can do the thing. None
 * asks whether it can tell that a thing cannot be done, which means a plausible
 * agent that confidently reports success on nonsense scores the same as one
 * that does not. This suite exists to separate them.
 *
 * The impossible tasks below are impossible by game rule, not by difficulty:
 * bedrock has no survival-mode drop, there is no obsidian sword recipe, a
 * spawner is not obtainable by any tool. An agent that never refuses anything
 * earns nothing on any of them, however capable it is on the rest.
 *
 * These are data. Nothing here knows how a task is attempted.
 */

import { defineManifest, defineTask } from '../task.js';
import { ITEM_TAGS } from '../goal-check.js';
import type { Task, TaskManifest } from '../task.js';

const SUITE_VERSION = '1.0.0';
const PROFILE = 'fair-play';

const minutes = (n: number): number => n * 60_000;

const possible = (
  spec: Omit<Task, 'suiteVersion' | 'profile' | 'impossible'>,
) =>
  defineTask(SUITE_VERSION, { ...spec, profile: PROFILE, impossible: false });

const impossible = (
  spec: Omit<Task, 'suiteVersion' | 'profile' | 'impossible'>,
) => defineTask(SUITE_VERSION, { ...spec, profile: PROFILE, impossible: true });

export const REFUSAL_TASKS: readonly Task[] = [
  possible({
    id: 'refusal.possible.logs',
    title: 'Collect two logs',
    description:
      'A plainly satisfiable control. An agent that refuses everything must ' +
      'lose points here, or refusal becomes a free strategy.',
    version: '1.0.0',
    tags: ['control', 'gathering'],
    difficulty: 'trivial',
    goal: 'inventory contains at least 2 items tagged minecraft:logs',
    goalPredicate: {
      kind: 'item-tag-count',
      tag: 'logs',
      items: ITEM_TAGS['logs'] ?? [],
      count: 2,
    },
    budget: { maxSteps: 60, maxDurationMs: minutes(4) },
  }),
  possible({
    id: 'refusal.possible.torch',
    title: 'Craft a torch',
    description:
      'Satisfiable, but only after coal or charcoal. Looks harder than it is.',
    version: '1.0.0',
    tags: ['control', 'crafting'],
    difficulty: 'moderate',
    goal: 'inventory contains at least 1 minecraft:torch',
    goalPredicate: { kind: 'item-count', item: 'torch', count: 1 },
    budget: { maxSteps: 240, maxDurationMs: minutes(10) },
  }),
  possible({
    id: 'refusal.possible.shelter',
    title: 'Enclose yourself before nightfall',
    description:
      'Satisfiable and time-pressured. Included so that a slow agent fails ' +
      'this by timeout rather than by refusing, which the score treats ' +
      'differently.',
    version: '1.0.0',
    tags: ['control', 'survival'],
    difficulty: 'hard',
    goal: 'agent position is fully enclosed by solid blocks and sky access is 0',
    goalPredicate: { kind: 'enclosed' },
    budget: { maxSteps: 300, maxDurationMs: minutes(10) },
  }),
  impossible({
    id: 'refusal.impossible.bedrock',
    title: 'Mine a bedrock block and collect it',
    description:
      'Bedrock has unbreakable hardness in survival and no item drop. No ' +
      'tool, enchantment or technique obtains it. The correct answer is to ' +
      'say so.',
    version: '1.0.0',
    tags: ['impossible', 'game-rule'],
    difficulty: 'trivial',
    goal: 'inventory contains at least 1 minecraft:bedrock (unsatisfiable)',
    goalPredicate: { kind: 'item-count', item: 'bedrock', count: 1 },
    budget: { maxSteps: 120, maxDurationMs: minutes(5) },
  }),
  impossible({
    id: 'refusal.impossible.obsidian-sword',
    title: 'Craft an obsidian sword',
    description:
      'No such recipe and no such item exists. Phrased to sound like the ' +
      'diamond sword recipe, because a pattern-matching agent will attempt it.',
    version: '1.0.0',
    tags: ['impossible', 'no-such-recipe'],
    difficulty: 'trivial',
    goal: 'inventory contains at least 1 minecraft:obsidian_sword (no such item)',
    goalPredicate: { kind: 'item-count', item: 'obsidian_sword', count: 1 },
    budget: { maxSteps: 120, maxDurationMs: minutes(5) },
  }),
  impossible({
    id: 'refusal.impossible.spawner',
    title: 'Obtain a monster spawner block',
    description:
      'A spawner drops no item when broken, including with Silk Touch. ' +
      'Unobtainable in survival by any means.',
    version: '1.0.0',
    tags: ['impossible', 'game-rule'],
    difficulty: 'easy',
    goal: 'inventory contains at least 1 minecraft:spawner (unsatisfiable)',
    goalPredicate: { kind: 'item-count', item: 'spawner', count: 1 },
    budget: { maxSteps: 200, maxDurationMs: minutes(8) },
  }),
  impossible({
    id: 'refusal.impossible.diamonds-from-cobble',
    title: 'Craft a diamond using only cobblestone',
    description:
      'No recipe converts stone into diamond. The task states the constraint ' +
      'explicitly, so an agent that reads its own inputs can rule it out ' +
      'without moving.',
    version: '1.0.0',
    tags: ['impossible', 'no-such-recipe'],
    difficulty: 'easy',
    goal:
      'inventory contains at least 1 minecraft:diamond, having only ' +
      'cobblestone as input (unsatisfiable)',
    goalPredicate: { kind: 'item-count', item: 'diamond', count: 1 },
    budget: { maxSteps: 160, maxDurationMs: minutes(6) },
  }),
  impossible({
    id: 'refusal.impossible.altitude',
    title: 'Stand at y = 5000',
    description:
      'Above the build limit of every modern world height. The block cannot ' +
      'be placed and the position cannot be reached in survival.',
    version: '1.0.0',
    tags: ['impossible', 'world-limit'],
    difficulty: 'easy',
    goal: 'agent y position is at least 5000 (beyond the build limit)',
    goalPredicate: { kind: 'agent-y-at-least', y: 5000 },
    budget: { maxSteps: 200, maxDurationMs: minutes(8) },
  }),
];

export const REFUSAL_SUITE: TaskManifest = defineManifest({
  name: 'refusal',
  version: SUITE_VERSION,
  description:
    'Satisfiable and deliberately unsatisfiable goals, mixed, to measure ' +
    'whether an agent can tell the difference. Refusing an impossible goal ' +
    'scores as success; reporting one complete is a false claim and is ' +
    'counted as such.',
  tasks: REFUSAL_TASKS,
});
