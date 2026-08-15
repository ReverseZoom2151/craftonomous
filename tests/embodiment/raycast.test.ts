import { describe, expect, it } from 'vitest';

import type { Vec3Like } from '../../src/embodiment/geometry.js';
import { key } from '../../src/embodiment/geometry.js';
import {
  MAX_TRAVERSAL_STEPS,
  firstSolid,
  isOccluded,
  traverse,
} from '../../src/embodiment/raycast.js';

/** Collect every voxel a traversal visits, without stopping it. */
function visited(from: Vec3Like, to: Vec3Like): string[] {
  const seen: string[] = [];
  traverse(from, to, (p) => {
    seen.push(key(p));
    return false;
  });
  return seen;
}

/** Solidity predicate backed by an explicit set of block coordinates. */
function solidSet(...positions: readonly Vec3Like[]): (p: Vec3Like) => boolean {
  const set = new Set(positions.map(key));
  return (p) => set.has(key(p));
}

const never = () => false;

describe('traverse', () => {
  it('visits exactly one voxel for a zero-length ray', () => {
    const p = { x: 3.25, y: 64.5, z: -7.75 };
    expect(visited(p, p)).toEqual(['3,64,-8']);
  });

  it('visits one voxel when both ends sit in the same block', () => {
    expect(visited({ x: 0.1, y: 0.1, z: 0.1 }, { x: 0.9, y: 0.9, z: 0.9 })).toEqual([
      '0,0,0',
    ]);
  });

  it('walks an axis-aligned ray one voxel at a time', () => {
    expect(visited({ x: 0.5, y: 0.5, z: 0.5 }, { x: 4.5, y: 0.5, z: 0.5 })).toEqual([
      '0,0,0',
      '1,0,0',
      '2,0,0',
      '3,0,0',
      '4,0,0',
    ]);
  });

  it('walks the other two axes just as evenly', () => {
    expect(visited({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0.5, y: 3.5, z: 0.5 })).toEqual([
      '0,0,0',
      '0,1,0',
      '0,2,0',
      '0,3,0',
    ]);
    expect(visited({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0.5, y: 0.5, z: 3.5 })).toEqual([
      '0,0,0',
      '0,0,1',
      '0,0,2',
      '0,0,3',
    ]);
  });

  it('walks negative directions', () => {
    expect(visited({ x: 2.5, y: 0.5, z: 0.5 }, { x: -1.5, y: 0.5, z: 0.5 })).toEqual([
      '2,0,0',
      '1,0,0',
      '0,0,0',
      '-1,0,0',
      '-2,0,0',
    ]);
  });

  it('starts stepping immediately when the origin sits on a boundary', () => {
    // Origin exactly on the x = 3 plane, heading in the negative direction: the
    // first step must leave voxel 3 rather than stalling on the boundary.
    const seen = visited({ x: 3, y: 0.5, z: 0.5 }, { x: 1.5, y: 0.5, z: 0.5 });
    expect(seen[0]).toBe('3,0,0');
    expect(seen.at(-1)).toBe('1,0,0');
  });

  it('reaches the destination voxel of a diagonal ray', () => {
    const seen = visited({ x: 0.5, y: 0.5, z: 0.5 }, { x: 4.5, y: 4.5, z: 4.5 });
    expect(seen[0]).toBe('0,0,0');
    expect(seen.at(-1)).toBe('4,4,4');
  });

  it('never skips a voxel: consecutive steps differ on exactly one axis by one', () => {
    const seen: Vec3Like[] = [];
    traverse({ x: 0.3, y: 0.7, z: 0.1 }, { x: 9.2, y: -4.4, z: 6.8 }, (p) => {
      seen.push(p);
      return false;
    });
    for (let i = 1; i < seen.length; i += 1) {
      const a = seen[i - 1];
      const b = seen[i];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      const delta = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
      expect(delta).toBe(1);
    }
    expect(seen.at(-1)).toEqual({ x: 9, y: -5, z: 6 });
  });

  it('stops at the first block the visitor claims', () => {
    const hit = traverse({ x: 0.5, y: 0.5, z: 0.5 }, { x: 9.5, y: 0.5, z: 0.5 }, (p) =>
      p.x === 4,
    );
    expect(hit).toEqual({ x: 4, y: 0, z: 0 });
  });

  it('reports the origin block when the visitor claims it', () => {
    const hit = traverse({ x: 0.5, y: 0.5, z: 0.5 }, { x: 9.5, y: 0.5, z: 0.5 }, () => true);
    expect(hit).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('terminates on a very long ray instead of looping forever', () => {
    let count = 0;
    const hit = traverse({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1e9, y: 0.5, z: 0.5 }, () => {
      count += 1;
      return false;
    });
    expect(hit).toBeUndefined();
    expect(count).toBeLessThanOrEqual(MAX_TRAVERSAL_STEPS + 1);
    expect(count).toBeGreaterThan(1);
  });

  it('honours a caller-supplied step budget', () => {
    let count = 0;
    traverse(
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 500.5, y: 0.5, z: 0.5 },
      () => {
        count += 1;
        return false;
      },
      { maxSteps: 10 },
    );
    expect(count).toBe(11);
  });

  it('refuses rays with non-finite endpoints', () => {
    let count = 0;
    const tally = () => {
      count += 1;
      return false;
    };
    expect(traverse({ x: NaN, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, tally)).toBeUndefined();
    expect(
      traverse({ x: 0, y: 0, z: 0 }, { x: Infinity, y: 0, z: 0 }, tally),
    ).toBeUndefined();
    expect(count).toBe(0);
  });
});

describe('isOccluded', () => {
  it('reports a clear line of sight', () => {
    expect(
      isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 20.5, y: 0.5, z: 0.5 }, never),
    ).toBe(false);
  });

  it('reports a wall between the two points', () => {
    const wall = solidSet({ x: 5, y: 0, z: 0 });
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 10.5, y: 0.5, z: 0.5 }, wall)).toBe(
      true,
    );
  });

  it('sees along an axis through a gap in a wall', () => {
    // A wall spanning y = -3..3 at x = 5, with the y = 0 row missing.
    const solids: Vec3Like[] = [];
    for (let y = -3; y <= 3; y += 1) {
      if (y === 0) continue;
      solids.push({ x: 5, y, z: 0 });
    }
    const wall = solidSet(...solids);
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 10.5, y: 0.5, z: 0.5 }, wall)).toBe(
      false,
    );
    expect(isOccluded({ x: 0.5, y: 1.5, z: 0.5 }, { x: 10.5, y: 1.5, z: 0.5 }, wall)).toBe(
      true,
    );
  });

  it('is not fooled by a diagonal sightline into an adjacent column', () => {
    const wall = solidSet({ x: 5, y: 0, z: 0 }, { x: 5, y: 1, z: 0 });
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 9.5, y: 1.5, z: 0.5 }, wall)).toBe(
      true,
    );
  });

  it('blocks a diagonal ray on every axis at once', () => {
    const wall = solidSet({ x: 2, y: 2, z: 2 });
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 4.5, y: 4.5, z: 4.5 }, wall)).toBe(
      true,
    );
  });

  it('is not blocked by the block the agent stands in', () => {
    // Standing inside stone, looking at open air one block away.
    const inside = solidSet({ x: 0, y: 0, z: 0 });
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 3.5, y: 0.5, z: 0.5 }, inside)).toBe(
      false,
    );
  });

  it('is not blocked by the block being looked at', () => {
    // Looking directly at an ore block: the ore itself must not hide itself.
    const ore = solidSet({ x: 6, y: 0, z: 0 });
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 6.5, y: 0.5, z: 0.5 }, ore)).toBe(
      false,
    );
  });

  it('is not blocked when both endpoints share a solid block', () => {
    const inside = solidSet({ x: 0, y: 0, z: 0 });
    expect(isOccluded({ x: 0.2, y: 0.2, z: 0.2 }, { x: 0.8, y: 0.8, z: 0.8 }, inside)).toBe(
      false,
    );
  });

  it('is not blocked by an adjacent target, however solid its surroundings', () => {
    const everything = () => true;
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1.5, y: 0.5, z: 0.5 }, everything)).toBe(
      false,
    );
  });

  it('blocks a target two blocks away with solid matter between', () => {
    const everything = () => true;
    expect(isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 2.5, y: 0.5, z: 0.5 }, everything)).toBe(
      true,
    );
  });

  it('reports zero-length rays as clear', () => {
    const everything = () => true;
    const p = { x: 1.5, y: 2.5, z: 3.5 };
    expect(isOccluded(p, p, everything)).toBe(false);
  });

  it('is symmetric across a wall', () => {
    const wall = solidSet({ x: 5, y: 0, z: 0 });
    const a = { x: 0.5, y: 0.5, z: 0.5 };
    const b = { x: 10.5, y: 0.5, z: 0.5 };
    expect(isOccluded(a, b, wall)).toBe(isOccluded(b, a, wall));
    expect(isOccluded(a, b, wall)).toBe(true);
  });

  it('reports a very long unobstructed ray as clear rather than hanging', () => {
    expect(
      isOccluded({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1e7, y: 500.5, z: 0.5 }, never),
    ).toBe(false);
  });
});

describe('firstSolid', () => {
  it('reports the origin block when the agent is buried', () => {
    const inside = solidSet({ x: 0, y: 0, z: 0 });
    expect(firstSolid({ x: 0.5, y: 0.5, z: 0.5 }, { x: 5.5, y: 0.5, z: 0.5 }, inside)).toEqual(
      { x: 0, y: 0, z: 0 },
    );
  });

  it('reports the nearest solid block along the ray', () => {
    const solids = solidSet({ x: 7, y: 0, z: 0 }, { x: 3, y: 0, z: 0 });
    expect(firstSolid({ x: 0.5, y: 0.5, z: 0.5 }, { x: 9.5, y: 0.5, z: 0.5 }, solids)).toEqual(
      { x: 3, y: 0, z: 0 },
    );
  });

  it('returns undefined for a clear ray', () => {
    expect(
      firstSolid({ x: 0.5, y: 0.5, z: 0.5 }, { x: 9.5, y: 0.5, z: 0.5 }, never),
    ).toBeUndefined();
  });
});
