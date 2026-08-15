/**
 * Run reports.
 *
 * The central claim of this project, made mechanical: a score never travels
 * without the conditions it was earned under. `formatReport` prints the
 * perception profile and the privileged-read share on the same lines as the
 * headline number, and there is no code path through this module that emits one
 * without the other. An agent that read ore through stone and an agent that
 * scouted the cave can both be reported here; what they cannot do is be
 * reported identically.
 */

import type { PerceptionReport } from '../perception/ledger.js';
import type { PerceptionProfile } from '../perception/profile.js';
import type { SuiteScore, TaskScore } from './scoring.js';
import type { AttemptRecord, SuiteRun } from './runner.js';

/**
 * One row of the skill reliability table.
 *
 * Declared structurally rather than imported from the skill layer, so that the
 * harness can report on any substrate that can produce these numbers. It is
 * shape-compatible with `ReliabilityStats & { skill }` in src/skills.
 */
export interface ReliabilityRow {
  readonly skill: string;
  readonly attempts: number;
  readonly successes: number;
  readonly rate: number;
  readonly confidence: number;
  readonly meanDurationMs: number;
}

export interface RunReport {
  readonly manifestName: string;
  readonly manifestVersion: string;
  readonly manifestHash: string;
  /** Identifies the agent under test. Free-form; recorded, never scored. */
  readonly agent: string;
  /** The profile the run was conducted under. Half of the run's identity. */
  readonly profile: PerceptionProfile;
  /** What the agent actually read, as counted by the ledger. */
  readonly perception: PerceptionReport;
  readonly repeats: number;
  readonly seed: number;
  readonly attempts: readonly AttemptRecord[];
  readonly byTask: readonly TaskScore[];
  readonly score: SuiteScore;
  readonly reliability: readonly ReliabilityRow[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface ReportInputs {
  readonly agent: string;
  readonly profile: PerceptionProfile;
  readonly perception: PerceptionReport;
  readonly reliability?: readonly ReliabilityRow[];
}

/** Assembles a report from a completed run and the run's conditions. */
export function buildReport(run: SuiteRun, inputs: ReportInputs): RunReport {
  return {
    manifestName: run.manifestName,
    manifestVersion: run.manifestVersion,
    manifestHash: run.manifestHash,
    agent: inputs.agent,
    profile: inputs.profile,
    perception: inputs.perception,
    repeats: run.repeats,
    seed: run.seed,
    attempts: run.attempts,
    byTask: run.byTask,
    score: run.score,
    reliability: inputs.reliability ?? [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function num(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  return x.toFixed(digits);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  rightAlignFrom = 1,
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? c.length;
        return i >= rightAlignFrom ? padLeft(c, w) : pad(c, w);
      })
      .join('  ')
      .trimEnd();
  const lines = [render(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) lines.push(render(row));
  return lines;
}

/**
 * Human-readable report.
 *
 * Every block that shows a score also shows the profile name and the
 * privileged-read share. This is repetitive on purpose: table rows get pasted
 * into issues and papers one at a time, and a number that leaves its conditions
 * behind is exactly the failure mode this project exists to prevent.
 */
export function formatReport(report: RunReport): string {
  const { score, profile, perception } = report;
  const conditions =
    `profile=${profile.name}  privileged=${pct(perception.privilegedShare)}` +
    `  fair-play=${perception.fairPlay ? 'yes' : 'no'}`;

  const lines: string[] = [];
  lines.push(`Craftonomous run report`);
  lines.push(
    `suite: ${report.manifestName} v${report.manifestVersion} ` +
      `(${report.manifestHash})`,
  );
  lines.push(`agent: ${report.agent}`);
  lines.push(`repeats: ${report.repeats}  seed: ${report.seed}`);
  lines.push('');

  lines.push('conditions');
  lines.push(`  ${conditions}`);
  lines.push(
    `  sight=${num(profile.sightRange, 0)}  ` +
      `line-of-sight=${profile.requireLineOfSight ? 'required' : 'not required'}  ` +
      `hearing=${num(profile.hearingRange, 0)}  ` +
      `privileged-reads=${profile.allowPrivileged ? 'allowed' : 'denied'}`,
  );
  lines.push(
    `  reads: ${perception.total} total, ${perception.privileged} privileged`,
  );
  lines.push('');

  lines.push(`score  [${conditions}]`);
  lines.push(
    `  wilson lower bound : ${num(score.confidence, 3)}   ` +
      `(observed ${pct(score.successRate)}, ` +
      `${score.credited}/${score.attempts})`,
  );
  lines.push(`  mean steps         : ${num(score.meanSteps)}`);
  lines.push(`  mean duration      : ${num(score.meanDurationMs, 0)} ms`);
  if (score.impossible.attempts > 0) {
    lines.push(
      `  possible tasks     : ${num(score.possible.confidence, 3)} ` +
        `(${score.possible.credited}/${score.possible.attempts})`,
    );
    lines.push(
      `  impossible tasks   : ${num(score.impossible.confidence, 3)} ` +
        `(${score.impossible.credited}/${score.impossible.attempts} refused)`,
    );
    lines.push(`  discrimination     : ${num(score.discrimination, 3)}`);
    lines.push(`  false claims       : ${score.falseClaims}`);
  }
  lines.push(
    `  outcomes           : ` +
      Object.entries(score.byKind)
        .map(([k, v]) => `${k}=${v}`)
        .join('  '),
  );
  lines.push('');

  lines.push(`tasks  [${conditions}]`);
  lines.push(
    ...table(
      ['task', 'kind', 'credited', 'rate', 'wilson', 'steps'],
      report.byTask.map((t) => [
        t.taskId,
        t.impossible ? 'impossible' : 'possible',
        `${t.credited}/${t.attempts}`,
        pct(t.successRate),
        num(t.confidence, 3),
        num(t.meanSteps),
      ]),
    ).map((l) => `  ${l}`),
  );

  if (report.reliability.length > 0) {
    lines.push('');
    lines.push(`skill reliability  [${conditions}]`);
    lines.push(
      ...table(
        ['skill', 'attempts', 'ok', 'rate', 'wilson', 'mean ms'],
        report.reliability.map((r) => [
          r.skill,
          String(r.attempts),
          String(r.successes),
          pct(r.rate),
          num(r.confidence, 3),
          num(r.meanDurationMs, 0),
        ]),
      ).map((l) => `  ${l}`),
    );
  }

  lines.push('');
  lines.push(
    `This score is valid only under profile "${profile.name}" with a ` +
      `privileged-read share of ${pct(perception.privilegedShare)}. ` +
      `Results earned under a different profile have not been compared.`,
  );
  return lines.join('\n');
}

/** JSON encoding that survives the profile's infinite ranges. */
function finite(x: number): number | string {
  return Number.isFinite(x) ? x : String(x);
}

export interface RunReportJSON {
  readonly schema: 'craftonomous.run-report/1';
  readonly suite: {
    readonly name: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly agent: string;
  readonly profile: Record<string, unknown>;
  readonly perception: PerceptionReport;
  readonly repeats: number;
  readonly seed: number;
  readonly score: SuiteScore;
  readonly byTask: readonly TaskScore[];
  readonly attempts: readonly AttemptRecord[];
  readonly reliability: readonly ReliabilityRow[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

/**
 * Machine-readable report. The profile and perception report sit at the top
 * level beside the score for the same reason they do in the printed table: a
 * consumer cannot read the number without tripping over the conditions.
 */
export function toJSON(report: RunReport): RunReportJSON {
  return {
    schema: 'craftonomous.run-report/1',
    suite: {
      name: report.manifestName,
      version: report.manifestVersion,
      hash: report.manifestHash,
    },
    agent: report.agent,
    profile: {
      name: report.profile.name,
      sightRange: finite(report.profile.sightRange),
      requireLineOfSight: report.profile.requireLineOfSight,
      hearingRange: finite(report.profile.hearingRange),
      memoryHorizonMs: finite(report.profile.memoryHorizonMs),
      allowPrivileged: report.profile.allowPrivileged,
    },
    perception: report.perception,
    repeats: report.repeats,
    seed: report.seed,
    score: report.score,
    byTask: report.byTask,
    attempts: report.attempts,
    reliability: report.reliability,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  };
}
