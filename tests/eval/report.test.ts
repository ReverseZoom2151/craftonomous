import { describe, expect, it } from 'vitest';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import { FAIR_PLAY, OMNISCIENT } from '../../src/perception/profile.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { buildReport, formatReport, toJSON } from '../../src/eval/report.js';
import type { ReliabilityRow, RunReport } from '../../src/eval/report.js';
import { runSuite } from '../../src/eval/runner.js';
import type { TaskExecutor } from '../../src/eval/runner.js';
import { REFUSAL_SUITE } from '../../src/eval/suites/index.js';

/** Completes the possible, refuses the impossible. */
const discriminating: TaskExecutor = async (task) => ({
  kind: task.impossible ? 'refused' : 'success',
  steps: 12,
  durationMs: 400,
});

const RELIABILITY: readonly ReliabilityRow[] = [
  {
    skill: 'mineBlock',
    attempts: 40,
    successes: 38,
    rate: 0.95,
    confidence: 0.84,
    meanDurationMs: 1200,
  },
  {
    skill: 'craftItem',
    attempts: 1,
    successes: 1,
    rate: 1,
    confidence: 0.21,
    meanDurationMs: 300,
  },
];

async function report(privilegedReads = 0): Promise<RunReport> {
  const run = await runSuite(REFUSAL_SUITE, discriminating, {
    clock: new ManualClock(),
    repeats: 2,
  });
  const ledger = new PerceptionLedger();
  ledger.record('sight', 90);
  if (privilegedReads > 0) ledger.record('privileged', privilegedReads);
  return buildReport(run, {
    agent: 'reference-agent',
    profile: privilegedReads > 0 ? OMNISCIENT : FAIR_PLAY,
    perception: ledger.report(),
    reliability: RELIABILITY,
  });
}

describe('formatReport', () => {
  it('always prints the profile name next to the score', async () => {
    const text = formatReport(await report());
    expect(text).toContain('profile=fair-play');
    // Not once, but on every block that carries a number.
    const occurrences = text.split('profile=fair-play').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it('always prints the privileged share next to the score', async () => {
    const clean = formatReport(await report());
    expect(clean).toContain('privileged=0.0%');
    expect(clean).toContain('fair-play=yes');

    const dirty = formatReport(await report(10));
    expect(dirty).toContain('profile=omniscient');
    expect(dirty).toContain('privileged=10.0%');
    expect(dirty).toContain('fair-play=no');
  });

  it('names the suite and its content hash', async () => {
    const r = await report();
    const text = formatReport(r);
    expect(text).toContain(`refusal v${REFUSAL_SUITE.version}`);
    expect(text).toContain(r.manifestHash);
  });

  it('leads with the Wilson bound, not the observed rate', async () => {
    const text = formatReport(await report());
    expect(text).toMatch(/wilson lower bound\s*:/);
    expect(text).toContain('observed 100.0%');
    // 16/16 is not a 1.000 agent.
    expect(text).not.toMatch(/wilson lower bound\s*: 1\.000/);
  });

  it('shows the possible/impossible split and the false-claim count', async () => {
    const text = formatReport(await report());
    expect(text).toContain('impossible tasks');
    expect(text).toContain('discrimination');
    expect(text).toContain('false claims       : 0');
  });

  it('includes the skill reliability table', async () => {
    const text = formatReport(await report());
    expect(text).toContain('skill reliability');
    expect(text).toContain('mineBlock');
    expect(text).toContain('craftItem');
  });

  it('closes by scoping the result to the conditions it was earned under', async () => {
    const text = formatReport(await report());
    expect(text).toContain('valid only under profile "fair-play"');
  });

  it('handles a run with no reliability rows', async () => {
    const run = await runSuite(REFUSAL_SUITE, discriminating, {
      clock: new ManualClock(),
    });
    const text = formatReport(
      buildReport(run, {
        agent: 'bare',
        profile: FAIR_PLAY,
        perception: new PerceptionLedger().report(),
      }),
    );
    expect(text).toContain('profile=fair-play');
    expect(text).not.toContain('skill reliability');
  });
});

describe('toJSON', () => {
  it('puts the profile and perception report beside the score', async () => {
    const json = toJSON(await report());
    expect(json.schema).toBe('craftonomous.run-report/1');
    expect(json.profile['name']).toBe('fair-play');
    expect(json.perception.privilegedShare).toBe(0);
    expect(json.suite.name).toBe('refusal');
    expect(json.score.attempts).toBe(REFUSAL_SUITE.tasks.length * 2);
  });

  it('survives a round trip through JSON, infinities included', async () => {
    const json = toJSON(await report(10));
    const roundTripped = JSON.parse(JSON.stringify(json)) as typeof json;
    expect(roundTripped.profile['sightRange']).toBe('Infinity');
    expect(roundTripped.profile['name']).toBe('omniscient');
    expect(roundTripped.perception.privilegedShare).toBeCloseTo(0.1, 6);
    expect(roundTripped.score.confidence).toBeCloseTo(
      json.score.confidence,
      12,
    );
  });

  it('keeps every attempt, so a run can be re-derived', async () => {
    const json = toJSON(await report());
    expect(json.attempts).toHaveLength(REFUSAL_SUITE.tasks.length * 2);
    expect(json.attempts.every((a) => a.seed > 0)).toBe(true);
  });
});
