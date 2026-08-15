import { describe, expect, it } from 'vitest';
import type { Provenance } from '../../src/observation/provenance.js';
import { PROVENANCE } from '../../src/observation/provenance.js';
import type { PerceptionReport } from '../../src/perception/ledger.js';
import { FAIR_PLAY, OMNISCIENT } from '../../src/perception/profile.js';
import { ReliabilityTracker } from '../../src/skills/reliability.js';
import {
  buildRunManifest,
  manifestToJson,
  reliabilityTable,
} from '../../src/mcp/manifest.js';

function report(
  overrides: Partial<Record<Provenance, number>>,
  privilegedAllowed = false,
): PerceptionReport {
  const counts = {
    ...(Object.fromEntries(PROVENANCE.map((p) => [p, 0])) as Record<
      Provenance,
      number
    >),
    ...overrides,
  };
  const total = PROVENANCE.reduce((n, p) => n + counts[p], 0);
  const privileged = counts.privileged;
  return {
    counts,
    total,
    privileged,
    privilegedShare: total === 0 ? 0 : privileged / total,
    fairPlay: privileged === 0 && !privilegedAllowed ? true : privileged === 0,
  };
}

function tracker(): ReliabilityTracker {
  const t = new ReliabilityTracker();
  for (let i = 0; i < 9; i += 1) {
    t.record('wood.chop', { succeeded: true, durationMs: 1_000 });
  }
  for (let i = 0; i < 9; i += 1) {
    t.record('ore.mine', { succeeded: false, durationMs: 500 });
  }
  return t;
}

describe('the per-skill reliability table', () => {
  it('ranks skills and marks the ones that have earned retirement', () => {
    const table = reliabilityTable(tracker());
    expect(table.map((r) => r.skill)).toEqual(['wood.chop', 'ore.mine']);
    expect(table[0]?.retired).toBe(false);
    expect(table[1]?.retired).toBe(true);
  });
});

describe('building a run manifest', () => {
  it('carries the outcome, the profile, the ledger and the skill table', () => {
    const manifest = buildRunManifest({
      outcome: { ok: true, task: 'gather-wood', score: 3 },
      profile: FAIR_PLAY,
      perception: report({ proprioception: 10, sight: 90 }),
      reliability: tracker(),
      startedAt: 1_000,
      finishedAt: 61_000,
    });

    expect(manifest.version).toBe(1);
    expect(manifest.outcome).toEqual({
      ok: true,
      task: 'gather-wood',
      score: 3,
    });
    expect(manifest.profile).toBe('fair-play');
    expect(manifest.profileDetail).toEqual(FAIR_PLAY);
    expect(manifest.perception.total).toBe(100);
    expect(manifest.skills.map((s) => s.skill)).toEqual([
      'wood.chop',
      'ore.mine',
    ]);
    expect(manifest.durationMs).toBe(60_000);
  });

  it('accepts a table that was already extracted from a tracker', () => {
    const table = reliabilityTable(tracker());
    const manifest = buildRunManifest({
      outcome: { ok: false, task: 'mine-iron', detail: 'ran out of time' },
      profile: FAIR_PLAY,
      perception: report({ sight: 40 }),
      reliability: table,
      startedAt: 0,
      finishedAt: 10,
    });
    expect(manifest.skills).toEqual(table);
  });

  it('puts the profile and the privileged share in the summary line', () => {
    const manifest = buildRunManifest({
      outcome: { ok: true, task: 'gather-wood' },
      profile: OMNISCIENT,
      perception: report({ sight: 90, privileged: 10 }, true),
      reliability: new ReliabilityTracker(),
      startedAt: 0,
      finishedAt: 5_000,
    });

    expect(manifest.summary).toContain('gather-wood succeeded');
    expect(manifest.summary).toContain('"omniscient"');
    expect(manifest.summary).toContain('100 observations');
    expect(manifest.summary).toContain('10.0% privileged');
    expect(manifest.summary).toContain('fair play broken');
  });

  it('reports a failure as a failure in the summary', () => {
    const manifest = buildRunManifest({
      outcome: { ok: false, task: 'mine-iron' },
      profile: FAIR_PLAY,
      perception: report({ sight: 10 }),
      reliability: tracker(),
      startedAt: 0,
      finishedAt: 1,
    });
    expect(manifest.summary).toContain('mine-iron failed');
    expect(manifest.summary).toContain('fair play preserved');
    expect(manifest.summary).toContain('9/18 attempts succeeded');
  });

  it('clamps a negative duration rather than reporting time running backwards', () => {
    const manifest = buildRunManifest({
      outcome: { ok: true, task: 'noop' },
      profile: FAIR_PLAY,
      perception: report({}),
      reliability: [],
      startedAt: 100,
      finishedAt: 50,
    });
    expect(manifest.durationMs).toBe(0);
  });
});

describe('serializing a manifest', () => {
  it('survives a profile with infinite ranges', () => {
    const manifest = buildRunManifest({
      outcome: { ok: true, task: 'noop' },
      profile: OMNISCIENT,
      perception: report({}),
      reliability: [],
      startedAt: 0,
      finishedAt: 1,
    });

    const parsed = JSON.parse(manifestToJson(manifest)) as {
      profileDetail: { sightRange: unknown };
      summary: string;
    };
    expect(parsed.profileDetail.sightRange).toBe('Infinity');
    expect(parsed.summary).toContain('omniscient');
  });
});
