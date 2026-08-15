import { z } from 'zod';
import type { Vec3Like } from '../../embodiment/geometry.js';
import { blockCentre, distance } from '../../embodiment/geometry.js';
import type { BlockInfo, EntityInfo, ItemStack } from '../../embodiment/types.js';
import type { Observed } from '../../observation/observed.js';
import { PerceptionDenied } from '../../perception/gate.js';
import type { SkillContext, SkillResult } from '../types.js';
import { fail } from '../types.js';

/**
 * Shared plumbing for the core skill library.
 *
 * Everything here reads the world through `ctx.world` only. There is
 * deliberately no path from this module to a `SensorPort`: if one appeared, the
 * perception ledger would start reporting a fiction.
 */

/** A position, as skills accept it on the wire. */
export const vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

/** The six block faces, as unit offsets. */
export const FACES: readonly Vec3Like[] = [
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

export function isUnitFace(face: Vec3Like): boolean {
  return FACES.some((f) => f.x === face.x && f.y === face.y && f.z === face.z);
}

/** Block names that occupy a cell without filling it. */
const AIR_LIKE = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
]);

export function isAirLike(name: string): boolean {
  return AIR_LIKE.has(name);
}

/** Blocks a container skill is willing to open. */
const CONTAINER_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'shulker_box',
  'furnace',
  'blast_furnace',
  'smoker',
  'dispenser',
  'dropper',
  'hopper',
]);

export function isContainerBlock(name: string): boolean {
  return CONTAINER_BLOCKS.has(name) || name.endsWith('_shulker_box');
}

/** Human-readable coordinate, for failure messages. */
export function show(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Runs the body of a skill with a clock-derived elapsed time and a uniform
 * translation of thrown errors into `SkillResult` failures.
 *
 * A read the profile forbade is `not-permitted` rather than `unknown`, because
 * the caller's remedy — change the profile, or explore for the fact — is
 * entirely different from the remedy for a bug.
 */
export async function guarded<T>(
  ctx: SkillContext,
  body: (elapsed: () => number) => Promise<SkillResult<T>>,
): Promise<SkillResult<T>> {
  const started = ctx.clock.now();
  const elapsed = (): number => ctx.clock.now() - started;
  try {
    return await body(elapsed);
  } catch (err) {
    if (err instanceof PerceptionDenied) {
      return fail('not-permitted', err.message, elapsed());
    }
    if (ctx.signal.aborted) {
      return fail('interrupted', 'cancelled while acting', elapsed());
    }
    return fail('unknown', describeError(err), elapsed());
  }
}

/** `fail('interrupted', ...)` when the caller has cancelled, else undefined. */
export function interruptCheck<T>(
  ctx: SkillContext,
  elapsed: () => number,
  where: string,
): SkillResult<T> | undefined {
  if (!ctx.signal.aborted) return undefined;
  return fail<T>('interrupted', `cancelled ${where}`, elapsed());
}

export function bodyPosition(ctx: SkillContext): Vec3Like {
  return ctx.world.body().value.position;
}

export function inventoryCounts(ctx: SkillContext): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const stack of ctx.world.inventory().value) {
    counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
  }
  return counts;
}

export function countOf(stacks: readonly ItemStack[], name: string): number {
  let total = 0;
  for (const s of stacks) if (s.name === name) total += s.count;
  return total;
}

export function heldCount(ctx: SkillContext, name: string): number {
  return inventoryCounts(ctx).get(name) ?? 0;
}

/** Total items gained across every stack name. Losses do not offset gains. */
export function totalGained(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): number {
  let gained = 0;
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0);
    if (delta > 0) gained += delta;
  }
  return gained;
}

/**
 * The nearest known block with one of these names.
 *
 * `undefined` means *not known*, which is not the same as *not there*: the
 * block may simply be outside sight. Callers must not act as though the space
 * were empty.
 */
export function nearestBlock(
  ctx: SkillContext,
  names: readonly string[],
  maxDistance: number,
  limit = 16,
): Observed<BlockInfo> | undefined {
  const from = bodyPosition(ctx);
  const found = ctx.world.findBlocks({ names, maxDistance, limit });
  let best: Observed<BlockInfo> | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of found) {
    const d = distance(from, blockCentre(candidate.value.position));
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** The nearest currently sensed entity whose name or username matches. */
export function nearestEntity(
  ctx: SkillContext,
  name: string,
  maxDistance: number,
): Observed<EntityInfo> | undefined {
  const from = bodyPosition(ctx);
  const wanted = name.toLowerCase();
  let best: Observed<EntityInfo> | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ctx.world.nearbyEntities({ maxDistance })) {
    const e = candidate.value;
    if (e.name.toLowerCase() !== wanted && e.username?.toLowerCase() !== wanted) {
      continue;
    }
    const d = distance(from, e.position);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

export function entityById(
  ctx: SkillContext,
  id: number,
  maxDistance: number,
): Observed<EntityInfo> | undefined {
  return ctx.world
    .nearbyEntities({ maxDistance })
    .find((e) => e.value.id === id);
}

/** Move until within `range` of a target, reporting why it did not happen. */
export async function moveWithin(
  ctx: SkillContext,
  target: Vec3Like,
  range: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const outcome = await ctx.act.moveTo(target, { range, signal: ctx.signal });
  if (!outcome.ok) {
    return { ok: false, detail: outcome.detail ?? 'the pathfinder gave up' };
  }
  const settled = distance(bodyPosition(ctx), target);
  // Trust the body over the pathfinder's own report: a mover that returns
  // success without arriving is exactly the failure this catches.
  if (settled > range + ARRIVAL_TOLERANCE) {
    return {
      ok: false,
      detail: `movement reported success but the body is ${settled.toFixed(1)} blocks from ${show(target)}`,
    };
  }
  return { ok: true };
}

/** Slack allowed between what the pathfinder claims and what the body says. */
export const ARRIVAL_TOLERANCE = 1;

/** How far a body can reach to dig or place. */
export const REACH = 5;

/** Real-time pause, used only where an action completes on the server's clock. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
