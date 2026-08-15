import type { Vec3Like } from './geometry.js';
import { equals, floor } from './geometry.js';

/**
 * Voxel traversal: Amanatides & Woo style DDA over the block grid.
 *
 * This is the enforcement mechanism behind `PerceptionProfile.requireLineOfSight`.
 * Without it the `fair-play` profile is a contract with no enforcer, so it is
 * written to be boring, total and hard to fool: no allocation-heavy stepping, no
 * recursion, no unbounded loops, and explicit answers for every degenerate input
 * (zero-length rays, axis-aligned rays, rays that begin inside solid matter).
 */

/**
 * Hard ceiling on voxels visited by a single traversal.
 *
 * A fair-play sight range of 64 blocks costs at most a few hundred steps, so
 * this is roughly an order of magnitude of headroom. It exists so that a NaN
 * slipping in from a substrate, or a caller asking for a ray across the whole
 * world, degrades into "not occluded" rather than hanging the agent's tick.
 */
export const MAX_TRAVERSAL_STEPS = 4096;

/** Tolerance for ray parameters landing exactly on a voxel boundary. */
const EPSILON = 1e-9;

export interface TraverseOptions {
  /** Override the defensive iteration cap. Clamped to {@link MAX_TRAVERSAL_STEPS}. */
  readonly maxSteps?: number;
}

function isFinitePoint(p: Vec3Like): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/**
 * Walk the voxel grid along the segment `from` -> `to`, calling `visit` on each
 * block coordinate in order, starting with the block containing `from` and
 * ending with the block containing `to`.
 *
 * Returns the first block for which `visit` returned true, or `undefined` when
 * the walk completed without a hit.
 */
export function traverse(
  from: Vec3Like,
  to: Vec3Like,
  visit: (position: Vec3Like) => boolean,
  options: TraverseOptions = {},
): Vec3Like | undefined {
  // A ray with a non-finite endpoint has no meaningful voxel path. Refusing to
  // walk it is safer than walking a corrupted one.
  if (!isFinitePoint(from) || !isFinitePoint(to)) return undefined;

  const cap = Math.min(
    MAX_TRAVERSAL_STEPS,
    Math.max(1, Math.floor(options.maxSteps ?? MAX_TRAVERSAL_STEPS)),
  );

  const start = floor(from);
  const end = floor(to);

  let x = start.x;
  let y = start.y;
  let z = start.z;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const stepZ = Math.sign(dz);

  // Distance, in units of the ray parameter t in [0, 1], between successive
  // crossings of each axis' voxel planes. Infinite for an axis we never cross.
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dz);

  let tMaxX = boundaryT(from.x, dx, x);
  let tMaxY = boundaryT(from.y, dy, y);
  let tMaxZ = boundaryT(from.z, dz, z);

  for (let steps = 0; steps <= cap; steps += 1) {
    const current: Vec3Like = { x, y, z };
    if (visit(current)) return current;

    // Reaching the destination voxel ends the walk regardless of how the
    // floating point arithmetic has drifted.
    if (x === end.x && y === end.y && z === end.z) return undefined;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (tMaxX > 1 + EPSILON) return undefined;
      x += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      if (tMaxY > 1 + EPSILON) return undefined;
      y += stepY;
      tMaxY += tDeltaY;
    } else {
      if (tMaxZ > 1 + EPSILON) return undefined;
      z += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  return undefined;
}

/**
 * Ray parameter at which the segment first leaves voxel `cell` along one axis.
 *
 * Infinite when the ray does not move along that axis, which makes the axis
 * never win the "smallest tMax" comparison in the traversal loop.
 */
function boundaryT(origin: number, delta: number, cell: number): number {
  if (delta === 0) return Number.POSITIVE_INFINITY;
  const plane = delta > 0 ? cell + 1 : cell;
  return (plane - origin) / delta;
}

/**
 * Whether solid matter stands between two points.
 *
 * The block containing `from` and the block containing `to` are both excluded:
 * an agent is not blinded by the block it stands in, nor by the block it is
 * looking at. Every voxel strictly between them counts.
 */
export function isOccluded(
  from: Vec3Like,
  to: Vec3Like,
  isSolid: (position: Vec3Like) => boolean,
  options: TraverseOptions = {},
): boolean {
  const origin = floor(from);
  const target = floor(to);

  // Same block, or no distance at all: nothing can stand in between.
  if (equals(origin, target)) return false;

  const hit = traverse(
    from,
    to,
    (position) => {
      if (equals(position, origin) || equals(position, target)) return false;
      return isSolid(position);
    },
    options,
  );

  return hit !== undefined;
}

/**
 * The first solid block along a ray, or `undefined` when the ray reaches its
 * destination unobstructed. Unlike {@link isOccluded} this reports the origin
 * block too, which is what a "am I stuck inside a wall?" check wants.
 */
export function firstSolid(
  from: Vec3Like,
  to: Vec3Like,
  isSolid: (position: Vec3Like) => boolean,
  options: TraverseOptions = {},
): Vec3Like | undefined {
  return traverse(from, to, isSolid, options);
}
