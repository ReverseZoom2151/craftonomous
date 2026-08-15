/**
 * A symbolic inventory: item names to counts, with no slots, no stack limits
 * and no NBT.
 *
 * Slots are deliberately absent. The sandbox exists to regression-test planning
 * logic, and slot packing is a property of the real client, not of the tech
 * tree. Modelling it here would add a source of divergence without adding a
 * question worth asking of a planner.
 *
 * Every mutation returns a new `Inventory`. Planning searches speculate: they
 * try a recipe, discover it does not close, and back out. Shared mutable state
 * is where that goes wrong.
 */

/** A plain item-name to count mapping. Counts are positive integers. */
export type ItemCounts = Readonly<Record<string, number>>;

function assertCount(count: number, what: string): void {
  if (!Number.isInteger(count)) {
    throw new RangeError(`${what} must be an integer, got ${count}`);
  }
  if (count < 0) {
    throw new RangeError(`${what} must not be negative, got ${count}`);
  }
}

function assertItem(item: string): void {
  if (item.length === 0) {
    throw new RangeError('item name must not be empty');
  }
}

export class Inventory {
  /** Only ever holds strictly positive integer counts. */
  readonly #counts: Map<string, number>;

  private constructor(counts: Map<string, number>) {
    this.#counts = counts;
  }

  static empty(): Inventory {
    return new Inventory(new Map());
  }

  /** Build from a record. Zero counts are dropped; negatives are refused. */
  static from(counts: ItemCounts): Inventory {
    const map = new Map<string, number>();
    for (const [item, count] of Object.entries(counts)) {
      assertItem(item);
      assertCount(count, `count for ${item}`);
      if (count > 0) map.set(item, count);
    }
    return new Inventory(map);
  }

  /** How many of `item` are held. Never negative. */
  count(item: string): number {
    return this.#counts.get(item) ?? 0;
  }

  has(item: string, count = 1): boolean {
    assertCount(count, `count for ${item}`);
    return this.count(item) >= count;
  }

  /** True when every entry of `required` is satisfied. */
  hasAll(required: ItemCounts): boolean {
    return Object.entries(required).every(([item, count]) =>
      this.has(item, count),
    );
  }

  /** The number of distinct item kinds held. */
  get size(): number {
    return this.#counts.size;
  }

  get isEmpty(): boolean {
    return this.#counts.size === 0;
  }

  /** Total units across all item kinds. */
  total(): number {
    let sum = 0;
    for (const count of this.#counts.values()) sum += count;
    return sum;
  }

  /** Item names held, in sorted order so callers never depend on insertion. */
  items(): readonly string[] {
    return [...this.#counts.keys()].sort();
  }

  add(item: string, count: number): Inventory {
    assertItem(item);
    assertCount(count, `count for ${item}`);
    if (count === 0) return this;
    const next = new Map(this.#counts);
    next.set(item, this.count(item) + count);
    return new Inventory(next);
  }

  addAll(counts: ItemCounts): Inventory {
    return Object.entries(counts).reduce<Inventory>(
      (acc, [item, count]) => acc.add(item, count),
      this,
    );
  }

  /**
   * Remove `count` of `item`.
   *
   * @throws RangeError when the inventory does not hold that many. Underflow is
   * a bug in the caller's arithmetic, not a state the model should represent:
   * silently clamping to zero would let a broken plan look like it succeeded.
   */
  remove(item: string, count: number): Inventory {
    assertItem(item);
    assertCount(count, `count for ${item}`);
    if (count === 0) return this;
    const held = this.count(item);
    if (held < count) {
      throw new RangeError(
        `cannot remove ${count} ${item}: inventory holds ${held}`,
      );
    }
    const next = new Map(this.#counts);
    if (held === count) next.delete(item);
    else next.set(item, held - count);
    return new Inventory(next);
  }

  /** Like `remove`, but returns `undefined` instead of throwing on underflow. */
  tryRemove(item: string, count: number): Inventory | undefined {
    assertCount(count, `count for ${item}`);
    if (!this.has(item, count)) return undefined;
    return this.remove(item, count);
  }

  removeAll(counts: ItemCounts): Inventory {
    return Object.entries(counts).reduce<Inventory>(
      (acc, [item, count]) => acc.remove(item, count),
      this,
    );
  }

  /** A plain object copy, key-sorted for stable snapshots and diffs. */
  toRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of this.items()) {
      out[item] = this.count(item);
    }
    return out;
  }

  /**
   * A structurally independent copy.
   *
   * Redundant given immutability, but the sandbox is handed to agent code we do
   * not control, and an explicit copy is cheaper than trusting it.
   */
  clone(): Inventory {
    return new Inventory(new Map(this.#counts));
  }

  equals(other: Inventory): boolean {
    if (this.#counts.size !== other.#counts.size) return false;
    for (const [item, count] of this.#counts) {
      if (other.count(item) !== count) return false;
    }
    return true;
  }

  toString(): string {
    if (this.isEmpty) return 'Inventory(empty)';
    const parts = this.items().map((i) => `${i} x${this.count(i)}`);
    return `Inventory(${parts.join(', ')})`;
  }
}
