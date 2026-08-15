import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/sandbox/inventory.js';

describe('Inventory construction', () => {
  it('starts empty', () => {
    const inv = Inventory.empty();
    expect(inv.isEmpty).toBe(true);
    expect(inv.size).toBe(0);
    expect(inv.total()).toBe(0);
    expect(inv.toRecord()).toEqual({});
  });

  it('drops zero counts rather than storing them', () => {
    const inv = Inventory.from({ oak_log: 3, stick: 0 });
    expect(inv.toRecord()).toEqual({ oak_log: 3 });
    expect(inv.count('stick')).toBe(0);
  });

  it('refuses a negative starting count', () => {
    expect(() => Inventory.from({ oak_log: -1 })).toThrow(RangeError);
  });

  it('refuses a fractional count', () => {
    expect(() => Inventory.from({ oak_log: 1.5 })).toThrow(RangeError);
  });

  it('reports zero for anything it has never seen', () => {
    expect(Inventory.empty().count('diamond')).toBe(0);
  });
});

describe('Inventory arithmetic', () => {
  it('adds and accumulates', () => {
    const inv = Inventory.empty().add('oak_log', 2).add('oak_log', 3);
    expect(inv.count('oak_log')).toBe(5);
    expect(inv.total()).toBe(5);
  });

  it('removes down to exactly zero and forgets the key', () => {
    const inv = Inventory.from({ stick: 2 }).remove('stick', 2);
    expect(inv.count('stick')).toBe(0);
    expect(inv.toRecord()).toEqual({});
    expect(inv.isEmpty).toBe(true);
  });

  it('refuses to go negative', () => {
    const inv = Inventory.from({ stick: 2 });
    expect(() => inv.remove('stick', 3)).toThrow(RangeError);
    // The refusal must leave the original untouched.
    expect(inv.count('stick')).toBe(2);
  });

  it('refuses to remove something it does not hold at all', () => {
    expect(() => Inventory.empty().remove('diamond', 1)).toThrow(RangeError);
  });

  it('reports underflow without throwing when asked to', () => {
    const inv = Inventory.from({ stick: 2 });
    expect(inv.tryRemove('stick', 3)).toBeUndefined();
    expect(inv.tryRemove('stick', 2)?.isEmpty).toBe(true);
  });

  it('refuses negative arguments outright', () => {
    const inv = Inventory.from({ stick: 2 });
    expect(() => inv.add('stick', -1)).toThrow(RangeError);
    expect(() => inv.remove('stick', -1)).toThrow(RangeError);
    expect(() => inv.has('stick', -1)).toThrow(RangeError);
  });

  it('never mutates the receiver', () => {
    const before = Inventory.from({ oak_log: 4 });
    const after = before.add('oak_log', 1).remove('oak_log', 5);
    expect(before.count('oak_log')).toBe(4);
    expect(after.count('oak_log')).toBe(0);
  });

  it('treats a zero-count change as a no-op', () => {
    const inv = Inventory.from({ oak_log: 1 });
    expect(inv.add('oak_log', 0)).toBe(inv);
    expect(inv.remove('oak_log', 0)).toBe(inv);
  });

  it('applies bulk changes', () => {
    const inv = Inventory.from({ oak_planks: 8, stick: 4 })
      .removeAll({ oak_planks: 3, stick: 2 })
      .addAll({ wooden_pickaxe: 1 });
    expect(inv.toRecord()).toEqual({
      oak_planks: 5,
      stick: 2,
      wooden_pickaxe: 1,
    });
  });

  it('rolls nothing back on a failed bulk removal', () => {
    // removeAll is not transactional; the caller checks first.
    const inv = Inventory.from({ oak_planks: 8, stick: 1 });
    expect(() => inv.removeAll({ oak_planks: 3, stick: 2 })).toThrow(
      RangeError,
    );
    expect(inv.toRecord()).toEqual({ oak_planks: 8, stick: 1 });
  });
});

describe('Inventory queries', () => {
  const inv = Inventory.from({ oak_planks: 3, stick: 2 });

  it('answers has() against the held count', () => {
    expect(inv.has('oak_planks')).toBe(true);
    expect(inv.has('oak_planks', 3)).toBe(true);
    expect(inv.has('oak_planks', 4)).toBe(false);
    expect(inv.has('diamond')).toBe(false);
  });

  it('answers hasAll() against a requirement set', () => {
    expect(inv.hasAll({ oak_planks: 3, stick: 2 })).toBe(true);
    expect(inv.hasAll({ oak_planks: 3, stick: 3 })).toBe(false);
    expect(inv.hasAll({})).toBe(true);
  });

  it('lists items in sorted order so snapshots are stable', () => {
    const messy = Inventory.from({ stick: 1, oak_planks: 1, diamond: 1 });
    expect(messy.items()).toEqual(['diamond', 'oak_planks', 'stick']);
    expect(Object.keys(messy.toRecord())).toEqual([
      'diamond',
      'oak_planks',
      'stick',
    ]);
  });

  it('clones independently', () => {
    const copy = inv.clone();
    expect(copy.equals(inv)).toBe(true);
    expect(copy).not.toBe(inv);
    expect(copy.add('stick', 1).equals(inv)).toBe(false);
  });

  it('compares by content', () => {
    expect(Inventory.from({ a: 1 }).equals(Inventory.from({ a: 1 }))).toBe(
      true,
    );
    expect(Inventory.from({ a: 1 }).equals(Inventory.from({ a: 2 }))).toBe(
      false,
    );
    expect(
      Inventory.from({ a: 1 }).equals(Inventory.from({ a: 1, b: 1 })),
    ).toBe(false);
  });

  it('renders readably', () => {
    expect(Inventory.empty().toString()).toBe('Inventory(empty)');
    expect(inv.toString()).toBe('Inventory(oak_planks x3, stick x2)');
  });
});
