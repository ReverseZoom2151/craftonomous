import { describe, expect, it } from 'vitest';
import {
  combine,
  isFairlyObtained,
  mapObserved,
  observe,
  recall,
} from '../../src/observation/observed.js';
import { isFairPlay } from '../../src/observation/provenance.js';

describe('observe', () => {
  it('carries value, provenance and sense time', () => {
    const o = observe(42, 'sight', 1000);
    expect(o).toEqual({ value: 42, provenance: 'sight', sensedAt: 1000 });
  });
});

describe('recall', () => {
  it('re-tags as memory and records staleness', () => {
    const seen = observe('iron_ore', 'sight', 1000);
    const remembered = recall(seen, 4500);
    expect(remembered.provenance).toBe('memory');
    expect(remembered.age).toBe(3500);
    expect(remembered.sensedAt).toBe(1000);
    expect(remembered.value).toBe('iron_ore');
  });

  it('never reports negative age when clocks disagree', () => {
    const seen = observe('cow', 'sight', 5000);
    expect(recall(seen, 4000).age).toBe(0);
  });
});

describe('mapObserved', () => {
  it('transforms the value without laundering provenance', () => {
    const o = observe(3, 'privileged', 10);
    const mapped = mapObserved(o, (n) => n * 2);
    expect(mapped.value).toBe(6);
    expect(mapped.provenance).toBe('privileged');
    expect(mapped.sensedAt).toBe(10);
  });
});

describe('combine', () => {
  it('rejects an empty premise set', () => {
    expect(() => combine([], 'x')).toThrow(/at least one/);
  });

  it('takes the weakest provenance among its premises', () => {
    const result = combine(
      [observe(1, 'proprioception', 100), observe(2, 'memory', 200)],
      'derived',
    );
    expect(result.provenance).toBe('memory');
  });

  it('takes the oldest sense time among its premises', () => {
    const result = combine(
      [observe(1, 'sight', 900), observe(2, 'sight', 100)],
      'derived',
    );
    expect(result.sensedAt).toBe(100);
  });

  it('propagates a privileged read so it cannot be laundered', () => {
    const result = combine(
      [observe(1, 'proprioception', 5), observe(2, 'privileged', 5)],
      'derived',
    );
    expect(result.provenance).toBe('privileged');
    expect(isFairlyObtained(result)).toBe(false);
  });

  it('keeps a fully fair derivation fair', () => {
    const result = combine(
      [observe(1, 'sight', 5), observe(2, 'inference', 7)],
      'derived',
    );
    expect(isFairlyObtained(result)).toBe(true);
  });
});

describe('isFairPlay', () => {
  it('admits every sense a player has', () => {
    for (const p of [
      'proprioception',
      'sight',
      'hearing',
      'memory',
      'inference',
      'testimony',
    ] as const) {
      expect(isFairPlay(p)).toBe(true);
    }
  });

  it('excludes privileged reads', () => {
    expect(isFairPlay('privileged')).toBe(false);
  });
});
