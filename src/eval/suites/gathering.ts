/**
 * Early-game gathering and crafting progression.
 *
 * Wood to planks to sticks to wooden tools to stone tools: the shortest honest
 * ladder in the game, and the one every Minecraft-agent paper opens with. It is
 * used here because each rung has a goal predicate that can be checked against
 * inventory state by exact item count: no rubric, no judge, no screenshot.
 *
 * These are data. Nothing here knows how a task is attempted; that arrives as
 * an injected executor at run time.
 */

import { defineManifest, defineTask } from '../task.js';
import type { Task, TaskManifest } from '../task.js';

const SUITE_VERSION = '1.0.0';
const PROFILE = 'fair-play';

const minutes = (n: number): number => n * 60_000;

const task = (spec: Omit<Task, 'suiteVersion' | 'profile' | 'impossible'>) =>
  defineTask(SUITE_VERSION, { ...spec, profile: PROFILE, impossible: false });

export const GATHERING_TASKS: readonly Task[] = [
  task({
    id: 'gather.logs.1',
    title: 'Collect one log',
    description:
      'Starting empty-handed in a forest, find a tree and break one log.',
    version: '1.0.0',
    tags: ['gathering', 'wood', 'smoke'],
    difficulty: 'trivial',
    goal: 'inventory contains at least 1 item tagged minecraft:logs',
    budget: { maxSteps: 40, maxDurationMs: minutes(3) },
  }),
  task({
    id: 'gather.logs.8',
    title: 'Collect eight logs',
    description:
      'Collect enough wood for a full early-game tool set. Tests whether an ' +
      'agent can repeat a working action rather than merely discover it once.',
    version: '1.0.0',
    tags: ['gathering', 'wood'],
    difficulty: 'easy',
    goal: 'inventory contains at least 8 items tagged minecraft:logs',
    budget: { maxSteps: 120, maxDurationMs: minutes(6) },
  }),
  task({
    id: 'craft.planks.4',
    title: 'Craft four planks',
    description:
      'Convert logs into planks. The first task requiring a recipe rather ' +
      'than a block interaction.',
    version: '1.0.0',
    tags: ['crafting', 'wood'],
    difficulty: 'easy',
    goal: 'inventory contains at least 4 items tagged minecraft:planks',
    budget: { maxSteps: 60, maxDurationMs: minutes(4) },
  }),
  task({
    id: 'craft.sticks.4',
    title: 'Craft four sticks',
    description:
      'A two-step recipe chain: logs to planks to sticks. Tests whether the ' +
      'agent plans through an intermediate it was not asked for.',
    version: '1.0.0',
    tags: ['crafting', 'wood', 'chaining'],
    difficulty: 'easy',
    goal: 'inventory contains at least 4 minecraft:stick',
    budget: { maxSteps: 80, maxDurationMs: minutes(5) },
  }),
  task({
    id: 'craft.crafting-table',
    title: 'Craft and place a crafting table',
    description:
      'Craft a crafting table and place it in the world. Placement matters: ' +
      'every recipe past 2x2 needs a table the agent can reach.',
    version: '1.0.0',
    tags: ['crafting', 'placement'],
    difficulty: 'easy',
    goal: 'a minecraft:crafting_table block exists within 4 blocks of the agent',
    budget: { maxSteps: 100, maxDurationMs: minutes(5) },
  }),
  task({
    id: 'craft.wooden-pickaxe',
    title: 'Craft a wooden pickaxe',
    description:
      'The full early chain: gather logs, craft planks and sticks, place a ' +
      'table, craft the pickaxe at it.',
    version: '1.0.0',
    tags: ['crafting', 'tools', 'chaining'],
    difficulty: 'moderate',
    goal: 'inventory contains at least 1 minecraft:wooden_pickaxe',
    budget: { maxSteps: 200, maxDurationMs: minutes(8) },
  }),
  task({
    id: 'gather.cobblestone.3',
    title: 'Mine three cobblestone',
    description:
      'Find exposed stone and mine it with a wooden pickaxe. The first task ' +
      'where the wrong tool yields nothing at all.',
    version: '1.0.0',
    tags: ['gathering', 'stone', 'tools'],
    difficulty: 'moderate',
    goal: 'inventory contains at least 3 minecraft:cobblestone',
    budget: { maxSteps: 220, maxDurationMs: minutes(10) },
  }),
  task({
    id: 'craft.stone-pickaxe',
    title: 'Craft a stone pickaxe',
    description:
      'The whole ladder end to end, from an empty inventory to a stone tool. ' +
      'The headline task of this suite.',
    version: '1.0.0',
    tags: ['crafting', 'tools', 'chaining', 'headline'],
    difficulty: 'hard',
    goal: 'inventory contains at least 1 minecraft:stone_pickaxe',
    budget: { maxSteps: 320, maxDurationMs: minutes(12) },
  }),
  task({
    id: 'craft.furnace',
    title: 'Craft a furnace',
    description:
      'Eight cobblestone into a furnace. Tests whether the agent keeps ' +
      'gathering past the minimum a previous task required.',
    version: '1.0.0',
    tags: ['crafting', 'stone'],
    difficulty: 'hard',
    goal: 'inventory contains at least 1 minecraft:furnace',
    budget: { maxSteps: 360, maxDurationMs: minutes(12) },
  }),
];

export const GATHERING_SUITE: TaskManifest = defineManifest({
  name: 'gathering',
  version: SUITE_VERSION,
  description:
    'Early-game gathering and crafting progression: wood to planks to sticks ' +
    'to wooden tools to stone tools. Every goal is an exact inventory or ' +
    'block-state predicate, checkable without a model in the loop.',
  tasks: GATHERING_TASKS,
});
