import type { PerceptionReport } from '../perception/ledger.js';
import type { PerceptionProfile } from '../perception/profile.js';
import type { ReliabilityStats } from '../skills/reliability.js';
import type { ReliabilityTracker } from '../skills/reliability.js';

/** What the run was trying to do, and whether it did it. */
export interface RunOutcome {
  readonly ok: boolean;
  /** What the run was asked to achieve. */
  readonly task: string;
  /** Free text: why it ended the way it did. */
  readonly detail?: string;
  /** Scenario score, when the scenario produces one. */
  readonly score?: number;
}

/** One row of the per-skill reliability table. */
export interface SkillReliabilityRow extends ReliabilityStats {
  readonly skill: string;
  readonly retired: boolean;
}

/**
 * Everything a run emits.
 *
 * The perception report is not an optional attachment. A score obtained under
 * `omniscient` and a score obtained under `fair-play` are measurements of
 * different things, and prior work reports the first as though it were the
 * second because nothing forced the profile to travel alongside the number.
 * Here they are one record, and the summary line repeats it so a result quoted
 * out of context still carries it.
 */
export interface RunManifest {
  readonly version: 1;
  readonly outcome: RunOutcome;
  /** The name of the profile the run was scored under. */
  readonly profile: string;
  /** The full profile, so a result can be reproduced rather than guessed at. */
  readonly profileDetail: PerceptionProfile;
  readonly perception: PerceptionReport;
  readonly skills: readonly SkillReliabilityRow[];
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  /** One line, safe to paste into a results table on its own. */
  readonly summary: string;
}

export interface BuildRunManifestOptions {
  readonly outcome: RunOutcome;
  readonly profile: PerceptionProfile;
  readonly perception: PerceptionReport;
  /** The tracker, or a table already extracted from one. */
  readonly reliability: ReliabilityTracker | readonly SkillReliabilityRow[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

function isTracker(
  value: BuildRunManifestOptions['reliability'],
): value is ReliabilityTracker {
  return !Array.isArray(value);
}

/** The per-skill table, sorted most to least reliable. */
export function reliabilityTable(
  tracker: ReliabilityTracker,
): readonly SkillReliabilityRow[] {
  return tracker.ranked().map((row) => ({
    ...row,
    retired: tracker.isRetired(row.skill),
  }));
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The one line a result gets quoted as.
 *
 * It names the profile and the privileged share because those are the two
 * facts that decide whether two numbers are comparable at all.
 */
export function summariseRun(
  outcome: RunOutcome,
  profile: PerceptionProfile,
  perception: PerceptionReport,
  skills: readonly SkillReliabilityRow[],
): string {
  const verdict = outcome.ok ? 'succeeded' : 'failed';
  const score = outcome.score === undefined ? '' : ` score=${outcome.score}`;
  const attempts = skills.reduce((n, s) => n + s.attempts, 0);
  const successes = skills.reduce((n, s) => n + s.successes, 0);
  const fairPlay = perception.fairPlay
    ? 'fair play preserved'
    : 'fair play broken';
  return (
    `${outcome.task} ${verdict}${score} under perception profile ` +
    `"${profile.name}" — ${perception.total} observations, ` +
    `${percent(perception.privilegedShare)} privileged, ${fairPlay}; ` +
    `${skills.length} skills tracked, ${successes}/${attempts} attempts succeeded`
  );
}

/** Assemble the record a run emits. */
export function buildRunManifest(
  options: BuildRunManifestOptions,
): RunManifest {
  const skills = isTracker(options.reliability)
    ? reliabilityTable(options.reliability)
    : options.reliability;

  return {
    version: 1,
    outcome: options.outcome,
    profile: options.profile.name,
    profileDetail: options.profile,
    perception: options.perception,
    skills,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    durationMs: Math.max(0, options.finishedAt - options.startedAt),
    summary: summariseRun(
      options.outcome,
      options.profile,
      options.perception,
      skills,
    ),
  };
}

/** Serialize a manifest. Infinities in a profile become null under JSON, so
 * they are written as strings to survive the round trip. */
export function manifestToJson(manifest: RunManifest, indent = 2): string {
  return JSON.stringify(
    manifest,
    (_key, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : value,
    indent,
  );
}
