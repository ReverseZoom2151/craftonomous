import { z } from 'zod';
import type { Vec3Like } from '../../embodiment/geometry.js';
import { blockCentre, distance } from '../../embodiment/geometry.js';
import type { PreconditionResult, Skill, SkillContext } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  bodyPosition,
  countOf,
  guarded,
  heldCount,
  interruptCheck,
  isContainerBlock,
  moveWithin,
  show,
  vec3Schema,
} from './support.js';

const itemRequest = z.object({
  name: z.string().min(1),
  /** How many to move. Omitted means as many as possible. */
  count: z.number().int().min(1).max(2304).optional(),
});

const movedItem = z.object({
  name: z.string(),
  requested: z.number().int(),
  moved: z.number().int(),
});

const containerInput = z.object({
  position: vec3Schema,
  items: z.array(itemRequest).min(1).max(36),
});
const containerOutput = z.object({
  position: vec3Schema,
  kind: z.string(),
  items: z.array(movedItem),
  total: z.number().int(),
});

export type ContainerSkillInput = z.infer<typeof containerInput>;
export type ContainerSkillOutput = z.infer<typeof containerOutput>;

/**
 * Shared precondition: the container must be a block the agent has actually
 * sensed. An unsensed coordinate is unknown, not empty, and walking off to
 * open a chest that was never seen is exactly the inference this refuses to
 * make on the caller's behalf.
 */
function checkContainerBlock(
  ctx: SkillContext,
  position: Vec3Like,
): PreconditionResult {
  const seen = ctx.world.blockAt(position);
  if (!seen) {
    return fails(
      `nothing is known about ${show(position)}; the container is out of sight, not necessarily absent`,
    );
  }
  if (!isContainerBlock(seen.value.name)) {
    return fails(`${seen.value.name} at ${show(position)} is not a container`);
  }
  return HOLDS;
}

/* ------------------------------------------------------------------ */
/* depositItems                                                        */
/* ------------------------------------------------------------------ */

export const depositItems: Skill<ContainerSkillInput, ContainerSkillOutput> = {
  name: 'depositItems',
  summary: 'Put items from the inventory into a chest or other container.',
  description: [
    'Walks to a known container, opens it, moves each requested item in, and',
    'closes it again. The close happens even when a transfer fails, because a',
    'container left open blocks every later interaction.',
    'The container must have been sensed: an unknown coordinate fails the',
    'precondition rather than sending the body somewhere on a guess. A block',
    'that turned out not to be a container by the time the agent arrived fails',
    '`world-changed`.',
    'Counts are read back from the inventory, so a partial transfer into a full',
    'chest is reported as the number that actually moved.',
    'Do not use this to throw things away; `dropItem` is for that.',
  ].join(' '),
  input: containerInput,
  output: containerOutput,
  precondition: (ctx, input) => {
    const block = checkContainerBlock(ctx, input.position);
    if (!block.holds) return Promise.resolve(block);
    for (const item of input.items) {
      const have = heldCount(ctx, item.name);
      if (have < 1) return Promise.resolve(fails(`no ${item.name} in the inventory`));
      if (item.count !== undefined && have < item.count) {
        return Promise.resolve(
          fails(`carrying ${have} ${item.name}, short of the ${item.count} requested`),
        );
      }
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'before depositing');
      if (interrupted) return interrupted;

      const centre = blockCentre(input.position);
      if (distance(bodyPosition(ctx), centre) > 3) {
        const moved = await moveWithin(ctx, centre, 3);
        if (!moved.ok) {
          const stopped = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'while approaching');
          if (stopped) return stopped;
          return fail(
            'unreachable',
            `could not reach the container at ${show(input.position)}: ${moved.detail}`,
            elapsed(),
          );
        }
      }

      const opened = await ctx.act.openContainer(input.position);
      if (!opened) {
        return fail(
          'world-changed',
          `nothing opens at ${show(input.position)} any more`,
          elapsed(),
        );
      }

      try {
        const results: { name: string; requested: number; moved: number }[] = [];
        let total = 0;
        for (const item of input.items) {
          const stopped = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'part way through');
          if (stopped) return stopped;

          const before = heldCount(ctx, item.name);
          const wanted = item.count ?? before;
          if (wanted < 1) {
            results.push({ name: item.name, requested: 0, moved: 0 });
            continue;
          }
          const outcome = await ctx.act.deposit(item.name, wanted);
          const moved = outcome.ok ? before - heldCount(ctx, item.name) : 0;
          results.push({ name: item.name, requested: wanted, moved });
          total += moved;
        }

        if (total === 0) {
          return fail(
            'unknown',
            `nothing moved into the container at ${show(input.position)}; it is probably full`,
            elapsed(),
          );
        }
        return succeed(
          { position: input.position, kind: opened.kind, items: results, total },
          elapsed(),
        );
      } finally {
        await ctx.act.closeContainer();
      }
    }),
};

/* ------------------------------------------------------------------ */
/* withdrawItems                                                       */
/* ------------------------------------------------------------------ */

export const withdrawItems: Skill<ContainerSkillInput, ContainerSkillOutput> = {
  name: 'withdrawItems',
  summary: 'Take items out of a chest or other container.',
  description: [
    'Walks to a known container, opens it, takes each requested item, and',
    'closes it again even if a transfer fails.',
    'What a closed container holds is not knowable from outside, so the',
    'quantities are settled after opening: taking fewer than asked is a',
    'success with the real number, and a container holding none of anything',
    'asked for fails `precondition`.',
    'The container itself must have been sensed; an unknown coordinate fails',
    'the precondition rather than being treated as an empty chest.',
    'Do not use this to check what a chest holds without taking anything;',
    'read the open-container view instead.',
  ].join(' '),
  input: containerInput,
  output: containerOutput,
  precondition: (ctx, input) => Promise.resolve(checkContainerBlock(ctx, input.position)),
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'before withdrawing');
      if (interrupted) return interrupted;

      const centre = blockCentre(input.position);
      if (distance(bodyPosition(ctx), centre) > 3) {
        const moved = await moveWithin(ctx, centre, 3);
        if (!moved.ok) {
          const stopped = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'while approaching');
          if (stopped) return stopped;
          return fail(
            'unreachable',
            `could not reach the container at ${show(input.position)}: ${moved.detail}`,
            elapsed(),
          );
        }
      }

      const opened = await ctx.act.openContainer(input.position);
      if (!opened) {
        return fail(
          'world-changed',
          `nothing opens at ${show(input.position)} any more`,
          elapsed(),
        );
      }

      try {
        const view = ctx.world.openContainer();
        const contents = view ? view.value.contents : opened.contents;
        const results: { name: string; requested: number; moved: number }[] = [];
        let total = 0;

        for (const item of input.items) {
          const stopped = interruptCheck<ContainerSkillOutput>(ctx, elapsed, 'part way through');
          if (stopped) return stopped;

          const available = countOf(contents, item.name);
          const wanted = Math.min(item.count ?? available, available);
          if (wanted < 1) {
            results.push({ name: item.name, requested: item.count ?? 0, moved: 0 });
            continue;
          }
          const before = heldCount(ctx, item.name);
          const outcome = await ctx.act.withdraw(item.name, wanted);
          const moved = outcome.ok ? heldCount(ctx, item.name) - before : 0;
          results.push({ name: item.name, requested: item.count ?? wanted, moved });
          total += moved;
        }

        if (total === 0) {
          return fail(
            'precondition',
            `the container at ${show(input.position)} holds none of ${input.items
              .map((i) => i.name)
              .join(', ')}`,
            elapsed(),
          );
        }
        return succeed(
          { position: input.position, kind: opened.kind, items: results, total },
          elapsed(),
        );
      } finally {
        await ctx.act.closeContainer();
      }
    }),
};
