import { z } from 'zod';
import type { Vec3Like } from '../../embodiment/geometry.js';
import { distance, floor, key } from '../../embodiment/geometry.js';
import type { Skill, SkillContext } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import {
  bodyPosition,
  guarded,
  interruptCheck,
  nearestBlock,
  show,
  vec3Schema,
} from './support.js';

/* ------------------------------------------------------------------ */
/* explore                                                             */
/* ------------------------------------------------------------------ */

/**
 * Exploration is the missing half of a gated perception profile.
 *
 * Under `fair-play` the usual answer to "where is the nearest oak_log" is *not
 * known*, and every skill in this library correctly refuses to guess. Without
 * a way to turn unknown into known, a rule policy that reaches for a block it
 * cannot see has nothing left to do, so this skill exists to move the body
 * until new ground enters sensing range.
 */

/**
 * Bearings in compass order, as unit vectors in the horizontal plane.
 *
 * The order matters. Walking E then W then E would oscillate between two spots
 * and cover almost nothing; walking the ring in order means consecutive legs
 * end next to each other, so the body sweeps an arc instead of crossing its own
 * start position on every leg.
 */
const DIAGONAL = Math.SQRT1_2;
const BEARINGS: readonly Vec3Like[] = [
  { x: 1, y: 0, z: 0 },
  { x: DIAGONAL, y: 0, z: DIAGONAL },
  { x: 0, y: 0, z: 1 },
  { x: -DIAGONAL, y: 0, z: DIAGONAL },
  { x: -1, y: 0, z: 0 },
  { x: -DIAGONAL, y: 0, z: -DIAGONAL },
  { x: 0, y: 0, z: -1 },
  { x: DIAGONAL, y: 0, z: -DIAGONAL },
];

/** Total ground distance an unconfigured run is willing to walk, in blocks. */
export const DEFAULT_EXPLORE_BUDGET = 96;
/** How far one leg reaches out from the origin, in blocks. */
export const DEFAULT_LEG_LENGTH = 16;
/** How far to look for `lookingFor` after each leg. */
export const DEFAULT_SEARCH_RADIUS = 32;

/**
 * Hard ceiling on legs, independent of the distance budget.
 *
 * The budget alone does not terminate a run: a body wedged in a hole travels
 * zero blocks per leg and would spend the budget forever. Three bounds are
 * checked, and any one of them ends the walk: distance travelled, legs
 * attempted, and consecutive legs that failed to shift the body.
 */
const MAX_LEGS = 16;
/** Consecutive legs that moved the body less than `MIN_LEG_PROGRESS`. */
const MAX_STALLED_LEGS = 3;
/** Displacement below which a leg counts as having gone nowhere, in blocks. */
const MIN_LEG_PROGRESS = 1;

/**
 * Coarse coverage probe: a lattice of sample cells around the body.
 *
 * Counting *newly known cells* rather than "chunks loaded" keeps the measure
 * inside what the perception gate actually permits. A cell that stays unknown
 * after standing next to it was hidden by the profile, and the honest report is
 * that exploring did not reveal it.
 */
const PROBE_RADIUS = 8;
const PROBE_STEP = 8;

function probeAround(ctx: SkillContext, known: Set<string>): void {
  const here = floor(bodyPosition(ctx));
  for (let dx = -PROBE_RADIUS; dx <= PROBE_RADIUS; dx += PROBE_STEP) {
    for (let dz = -PROBE_RADIUS; dz <= PROBE_RADIUS; dz += PROBE_STEP) {
      const cell = { x: here.x + dx, y: here.y, z: here.z + dz };
      if (ctx.world.blockAt(cell)) known.add(key(cell));
    }
  }
}

/**
 * Which tile a position falls in, ignoring height.
 *
 * Tiles are half a leg across rather than a whole leg, so that the four
 * diagonal targets of a ring (which sit at `0.707 * radius` on each axis) land
 * in different tiles from the four cardinal ones and are not mistaken for
 * ground already covered.
 */
function tileKey(position: Vec3Like, legLength: number): string {
  const size = Math.max(1, legLength / 2);
  return `${Math.floor(position.x / size)},${Math.floor(position.z / size)}`;
}

const exploreInput = z.object({
  /** Block name to watch for while walking, e.g. `oak_log`. */
  lookingFor: z.string().min(1).optional(),
  /**
   * Alias for `lookingFor`, accepted because `RulePolicy` emits this spelling.
   * Give one or the other; `lookingFor` wins if both appear.
   */
  looking_for: z.string().min(1).optional(),
  /** Ground distance the walk may spend, in blocks. Defaults to 96. */
  budget: z.number().min(1).max(1024).optional(),
  /** How far each leg reaches from the starting point. Defaults to 16. */
  legLength: z.number().min(4).max(128).optional(),
  /** How far to search for `lookingFor`. Defaults to 32. */
  searchRadius: z.number().min(1).max(256).optional(),
});

const exploreOutput = z.object({
  /** What was being watched for, if anything. */
  lookingFor: z.string().optional(),
  /** True only when `lookingFor` was given and became known. */
  found: z.boolean(),
  /** Where it was found, when it was. */
  foundAt: vec3Schema.optional(),
  /** Where the walk started. */
  origin: vec3Schema,
  /** Where the body ended up. */
  position: vec3Schema,
  /** Ground actually covered, measured from the body between legs. */
  distanceTravelled: z.number(),
  /** Legs attempted. A leg whose target was already visited is not attempted. */
  legs: z.number().int(),
  /** Legs that shifted the body at least `MIN_LEG_PROGRESS` blocks. */
  legsMoved: z.number().int(),
  /** Sample cells that went from unknown to known during the walk. */
  newlyKnown: z.number().int(),
  /** Which of the termination bounds ended the walk. */
  stoppedBecause: z.enum(['found', 'budget', 'legs', 'stalled']),
});

export type ExploreInput = z.infer<typeof exploreInput>;
export type ExploreOutput = z.infer<typeof exploreOutput>;

export const explore: Skill<ExploreInput, ExploreOutput> = {
  name: 'explore',
  summary: 'Walk unvisited ground so that new terrain enters sensing range.',
  description: [
    'Turns *unknown* into *known*. Walks an expanding ring of legs around the',
    'starting point, watching for `lookingFor` after each one, and reports how',
    'much new ground came into range.',
    'Finding nothing is a success with `found: false`, not a failure: the agent',
    'did the thing it was asked to do, and the caller needs to distinguish',
    '"looked and it is not around here" from "could not look". Only a body that',
    'never moved at all fails, as `unreachable`, because that is a boxed-in',
    'body and no amount of retrying will help.',
    'It terminates on whichever of three bounds comes first: the distance',
    'budget, a ceiling on legs, or three legs in a row that shifted the body',
    'nowhere. It never revisits a tile it has already stood in during the run,',
    'so it cannot oscillate between two spots.',
    'Do not use this when the target is already sensed or recalled; `goToBlock`',
    'walks straight to it and this would waste the budget. Do not use it to',
    'reach a coordinate you already have, which is `goToPosition`, and do not',
    'use it to dig out of a hole: it walks the surface it is given and does not',
    'break blocks.',
  ].join(' '),
  input: exploreInput,
  output: exploreOutput,
  precondition: (ctx, input) => {
    const wanted = input.lookingFor ?? input.looking_for;
    if (wanted === undefined) return Promise.resolve(HOLDS);
    const searchRadius = input.searchRadius ?? DEFAULT_SEARCH_RADIUS;
    const already = nearestBlock(ctx, [wanted], searchRadius);
    if (already) {
      return Promise.resolve(
        fails(
          `${wanted} is already known at ${show(already.value.position)}; go to it rather than exploring for it`,
        ),
      );
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const wanted = input.lookingFor ?? input.looking_for;
      const budget = input.budget ?? DEFAULT_EXPLORE_BUDGET;
      const legLength = input.legLength ?? DEFAULT_LEG_LENGTH;
      const searchRadius = input.searchRadius ?? DEFAULT_SEARCH_RADIUS;

      const interrupted = interruptCheck<ExploreOutput>(
        ctx,
        elapsed,
        'before exploring',
      );
      if (interrupted) return interrupted;

      const origin = bodyPosition(ctx);
      const knownAtStart = new Set<string>();
      probeAround(ctx, knownAtStart);
      const known = new Set(knownAtStart);
      const visited = new Set<string>([tileKey(origin, legLength)]);

      const report = (
        stoppedBecause: ExploreOutput['stoppedBecause'],
        found: Vec3Like | undefined,
        travelled: number,
        legs: number,
        legsMoved: number,
      ): ExploreOutput => ({
        ...(wanted === undefined ? {} : { lookingFor: wanted }),
        found: found !== undefined,
        ...(found === undefined ? {} : { foundAt: found }),
        origin,
        position: bodyPosition(ctx),
        distanceTravelled: travelled,
        legs,
        legsMoved,
        newlyKnown: known.size - knownAtStart.size,
        stoppedBecause,
      });

      const sighting = (): Vec3Like | undefined => {
        if (wanted === undefined) return undefined;
        return nearestBlock(ctx, [wanted], searchRadius)?.value.position;
      };

      // The precondition already rejects a target that is in plain sight, but
      // `run` is charitable about it: between the check and the walk the world
      // may have shifted, and handing back the location beats failing.
      const alreadyThere = sighting();
      if (alreadyThere) {
        return succeed(report('found', alreadyThere, 0, 0, 0), elapsed());
      }

      let travelled = 0;
      let legs = 0;
      let legsMoved = 0;
      let stalled = 0;
      let lastDetail = '';
      let stoppedBecause: ExploreOutput['stoppedBecause'] = 'legs';

      for (let index = 0; index < MAX_LEGS; index += 1) {
        if (travelled >= budget) {
          stoppedBecause = 'budget';
          break;
        }
        const stop = interruptCheck<ExploreOutput>(
          ctx,
          elapsed,
          `after ${legs} legs`,
        );
        if (stop) return stop;

        // Expanding ring: bearing cycles through the compass, and the radius
        // grows by one leg length each time the compass comes round. Every
        // target is therefore further out than the one eight legs before it,
        // which is what makes the pattern outward rather than circular.
        const bearing = BEARINGS[index % BEARINGS.length];
        if (!bearing) break;
        const radius = legLength * (1 + Math.floor(index / BEARINGS.length));
        const target = {
          x: origin.x + bearing.x * radius,
          y: origin.y,
          z: origin.z + bearing.z * radius,
        };
        const targetTile = tileKey(target, legLength);
        if (visited.has(targetTile)) continue;
        visited.add(targetTile);

        const before = bodyPosition(ctx);
        legs += 1;
        const outcome = await ctx.act.moveTo(target, {
          range: 2,
          signal: ctx.signal,
        });
        const after = bodyPosition(ctx);
        const moved = distance(before, after);
        travelled += moved;
        visited.add(tileKey(after, legLength));

        // The mover's own verdict is not the authority here. A pathfinder that
        // gave up halfway still carried the body onto new ground, and ground
        // covered is the entire point of this skill.
        if (moved >= MIN_LEG_PROGRESS) {
          legsMoved += 1;
          stalled = 0;
        } else {
          stalled += 1;
          lastDetail =
            outcome.detail ?? `the body did not shift towards ${show(target)}`;
          if (stalled >= MAX_STALLED_LEGS) {
            stoppedBecause = 'stalled';
            break;
          }
          continue;
        }

        probeAround(ctx, known);

        const seen = sighting();
        if (seen) {
          return succeed(
            report('found', seen, travelled, legs, legsMoved),
            elapsed(),
          );
        }
      }

      if (legsMoved === 0) {
        const cancelled = interruptCheck<ExploreOutput>(
          ctx,
          elapsed,
          'while exploring',
        );
        if (cancelled) return cancelled;
        return fail(
          'unreachable',
          `explored nowhere from ${show(origin)}: ${
            lastDetail || 'every leg left the body where it started'
          }`,
          elapsed(),
        );
      }

      // Walked, looked, found nothing. That is an answer, not an error.
      return succeed(
        report(stoppedBecause, undefined, travelled, legs, legsMoved),
        elapsed(),
      );
    }),
};
