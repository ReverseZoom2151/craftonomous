/**
 * The smallest amount of space the sandbox can get away with.
 *
 * Three shipped eval goals are positional: a crafting table within four blocks
 * of the agent, an agent sealed in on all six sides, and an agent above an
 * altitude. None of them can be stated against an inventory alone, so the
 * offline tier reported them unscorable and every agent went unmeasured on the
 * cheapest half of the benchmark. What follows is exactly enough geometry to
 * state those three and no more.
 *
 * ## What this deliberately is not
 *
 * This is a sparse map of integer block coordinates. It is not a voxel engine
 * and must never be read as one. In particular there is:
 *
 * - **no terrain.** Space is empty except for blocks a scenario placed or the
 *   agent put down. There is no ground, no ore in situ and no sky; `mine`
 *   still draws from the abstract `resources` pile and has nothing to do with
 *   any coordinate.
 * - **no gravity and no support rule.** The agent may step up into empty air
 *   and a placed block may float. What stops an agent climbing forever is the
 *   build limit, which is a world rule, not physics.
 * - **no collision volume.** The agent occupies exactly one block cell, has no
 *   height and no hitbox, so "enclosed" means the six faces of that single
 *   cell. A real player is two blocks tall and the real check is harder.
 * - **no block states, no transparency and no light.** Every placed block is
 *   solid and opaque. There are no slabs, no water, no sky-light value, so a
 *   goal sentence asking for sky access of 0 is answered only by the six-face
 *   test, which is the weaker claim.
 * - **no path finding, no line of sight, no chunk loading, no entities and no
 *   time.** Movement is a single step to an adjacent cell, and nothing in the
 *   world moves on its own.
 *
 * The point of the sandbox is that it is fast and deterministic. It stops
 * being worth anything the moment somebody reads a score from it as a claim
 * about the real game.
 */

/** A block coordinate. Integer components; there are no sub-block positions. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A block the world holds at a coordinate. Every one of them is solid. */
export interface PlacedBlock {
  readonly position: Vec3;
  readonly name: string;
}

/** Where an agent stands when a scenario does not say. */
export const DEFAULT_AGENT_POSITION: Vec3 = { x: 0, y: 64, z: 0 };

/** Lowest buildable y, matching the modern overworld floor. */
export const DEFAULT_WORLD_FLOOR = -64;

/**
 * Highest buildable y, inclusive, matching the modern overworld build limit.
 *
 * This is what keeps `refusal.impossible.altitude` impossible offline. Without
 * it a world with no gravity would let an agent walk to y = 5000 and a goal the
 * suite ships as unreachable would be reached.
 */
export const DEFAULT_BUILD_LIMIT = 319;

/** How far from the agent a block may be placed, in blocks. */
export const DEFAULT_PLACE_REACH = 4;

/** The six face neighbours of a cell, in a fixed order for determinism. */
export const FACE_OFFSETS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

export function isBlockPosition(p: Vec3): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z);
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sameVec(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Straight-line distance, the same measure the live tier's goal check uses. */
export function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Largest single-axis difference. One step is a Chebyshev distance of one. */
export function chebyshevDistance(a: Vec3, b: Vec3): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z),
  );
}

/** A map key for a coordinate. Only ever used for exact lookups. */
export function positionKey(p: Vec3): string {
  return `${p.x},${p.y},${p.z}`;
}

export function formatPosition(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
