import { describe, expect, it } from 'vitest';
import { PerceptionDenied, PerceptionGate } from '../../src/perception/gate.js';
import {
  FAIR_PLAY,
  OMNISCIENT,
  XRAY,
  profileByName,
} from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';

const gateFor = (profile = FAIR_PLAY, clock = new ManualClock(1000)) =>
  ({ gate: new PerceptionGate(profile, clock), clock }) as const;

describe('canSee', () => {
  it('sees an unobstructed target within range', () => {
    const { gate } = gateFor();
    expect(gate.canSee({ distance: 10, occluded: false })).toBe(true);
  });

  it('does not see past the range limit', () => {
    const { gate } = gateFor();
    expect(gate.canSee({ distance: 65, occluded: false })).toBe(false);
  });

  it('sees exactly at the range limit', () => {
    const { gate } = gateFor();
    expect(gate.canSee({ distance: 64, occluded: false })).toBe(true);
  });

  it('does not see through a wall under fair play', () => {
    const { gate } = gateFor();
    expect(gate.canSee({ distance: 5, occluded: true })).toBe(false);
  });

  it('sees through a wall under xray, still bounded by range', () => {
    const { gate } = gateFor(XRAY);
    expect(gate.canSee({ distance: 5, occluded: true })).toBe(true);
    expect(gate.canSee({ distance: 999, occluded: true })).toBe(false);
  });
});

describe('canHear', () => {
  it('bounds hearing by range', () => {
    const { gate } = gateFor();
    expect(gate.canHear(16)).toBe(true);
    expect(gate.canHear(17)).toBe(false);
  });
});

describe('hasExpired', () => {
  it('forgets a fact past the memory horizon', () => {
    const { gate, clock } = gateFor();
    clock.advance(FAIR_PLAY.memoryHorizonMs + 1);
    expect(gate.hasExpired(1000)).toBe(true);
  });

  it('keeps a fact inside the horizon', () => {
    const { gate, clock } = gateFor();
    clock.advance(FAIR_PLAY.memoryHorizonMs);
    expect(gate.hasExpired(1000)).toBe(false);
  });

  it('never forgets under an unbounded horizon', () => {
    const { gate, clock } = gateFor(OMNISCIENT);
    clock.advance(Number.MAX_SAFE_INTEGER);
    expect(gate.hasExpired(0)).toBe(false);
  });
});

describe('sense', () => {
  it('stamps the observation with the current time', () => {
    const { gate, clock } = gateFor();
    clock.advance(250);
    expect(gate.sense('cow', 'sight').sensedAt).toBe(1250);
  });

  it('refuses a privileged read under fair play', () => {
    const { gate } = gateFor();
    expect(() => gate.sense('diamond', 'privileged')).toThrow(PerceptionDenied);
  });

  it('names the profile in the refusal so the cause is not buried', () => {
    const { gate } = gateFor();
    expect(() => gate.sense('diamond', 'privileged')).toThrow(/fair-play/);
  });

  it('allows a privileged read when the profile permits it', () => {
    const { gate } = gateFor(OMNISCIENT);
    expect(gate.sense('diamond', 'privileged').value).toBe('diamond');
  });

  it('does not count a refused read', () => {
    const { gate } = gateFor();
    expect(() => gate.sense('diamond', 'privileged')).toThrow();
    expect(gate.ledger.report().total).toBe(0);
  });
});

describe('sight and sound', () => {
  it('returns undefined rather than a value when out of range', () => {
    const { gate } = gateFor();
    expect(
      gate.sight('ore', { distance: 100, occluded: false }),
    ).toBeUndefined();
    expect(gate.sound('footstep', 100)).toBeUndefined();
  });

  it('does not count an observation that was never made', () => {
    const { gate } = gateFor();
    gate.sight('ore', { distance: 100, occluded: false });
    gate.sound('footstep', 100);
    expect(gate.ledger.report().total).toBe(0);
  });

  it('counts a sighting that succeeded', () => {
    const { gate } = gateFor();
    expect(gate.sight('ore', { distance: 4, occluded: false })?.value).toBe(
      'ore',
    );
    expect(gate.ledger.report().counts.sight).toBe(1);
  });
});

describe('ledger reporting', () => {
  it('reports fair play when nothing privileged was read', () => {
    const { gate } = gateFor();
    gate.sense('self', 'proprioception');
    gate.sense('tree', 'sight');
    const report = gate.ledger.report();
    expect(report.fairPlay).toBe(true);
    expect(report.privileged).toBe(0);
    expect(report.privilegedShare).toBe(0);
    expect(report.total).toBe(2);
  });

  it('reports the privileged share once the agent reads past its senses', () => {
    const { gate } = gateFor(OMNISCIENT);
    gate.sense('tree', 'sight');
    gate.sense('ore', 'privileged');
    gate.sense('ore', 'privileged');
    const report = gate.ledger.report();
    expect(report.fairPlay).toBe(false);
    expect(report.privileged).toBe(2);
    expect(report.privilegedShare).toBeCloseTo(2 / 3);
  });

  it('treats an empty run as fair rather than dividing by zero', () => {
    const { gate } = gateFor();
    const report = gate.ledger.report();
    expect(report.privilegedShare).toBe(0);
    expect(report.fairPlay).toBe(true);
  });
});

describe('profileByName', () => {
  it('resolves the built-in profiles', () => {
    expect(profileByName('fair-play')).toBe(FAIR_PLAY);
    expect(profileByName('xray')).toBe(XRAY);
    expect(profileByName('omniscient')).toBe(OMNISCIENT);
  });

  it('returns undefined for an unknown profile', () => {
    expect(profileByName('wallhack')).toBeUndefined();
  });
});
