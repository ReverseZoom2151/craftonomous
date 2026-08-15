/** A point or offset in world space. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function vec3(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

export function add(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3Like, k: number): Vec3Like {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

export function length(a: Vec3Like): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return length(subtract(a, b));
}

/**
 * Squared distance. Preferred inside hot loops such as nearest-entity scans,
 * where the square root is pure cost and the ordering is identical.
 */
export function distanceSquared(a: Vec3Like, b: Vec3Like): number {
  const d = subtract(a, b);
  return d.x * d.x + d.y * d.y + d.z * d.z;
}

export function normalize(a: Vec3Like): Vec3Like {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / len);
}

export function equals(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Round down to the containing block coordinate. */
export function floor(a: Vec3Like): Vec3Like {
  return { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) };
}

/** Centre of the block containing this position. */
export function blockCentre(a: Vec3Like): Vec3Like {
  const f = floor(a);
  return { x: f.x + 0.5, y: f.y + 0.5, z: f.z + 0.5 };
}

/** Stable string form, suitable as a map key. */
export function key(a: Vec3Like): string {
  const f = floor(a);
  return `${f.x},${f.y},${f.z}`;
}
