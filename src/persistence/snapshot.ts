/**
 * The on-disk shape of an agent's durable state, and the decoder that refuses
 * to guess at anything it does not recognise.
 *
 * Two things are persisted, because they are the two things whose loss makes a
 * long run indistinguishable from a cold start: what the agent has seen, and
 * how well its skills have actually worked.
 */

import type { BlockInfo } from '../embodiment/types.js';
import type { Provenance } from '../observation/provenance.js';
import { PROVENANCE } from '../observation/provenance.js';
import { SnapshotFormatError, SnapshotVersionError } from './errors.js';

/**
 * Schema version this build writes.
 *
 * Version history:
 *   1: world memory only.
 *   2: adds reliability evidence. A version 1 file still loads, with no
 *      recorded evidence, which is honest: it never had any.
 */
export const SCHEMA_VERSION = 2;

/** Oldest schema version this build can still read. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

/** One remembered sighting, with the moment it was sensed. */
export interface ObservationRecord {
  readonly block: BlockInfo;
  readonly provenance: Provenance;
  /**
   * Wall-clock milliseconds at which this was sensed. Persisted verbatim and
   * restored verbatim. A restore that re-stamped this with the current time
   * would turn hours-old belief into a present-tense sighting, which is the
   * exact fabrication the provenance layer exists to prevent.
   */
  readonly sensedAt: number;
}

export interface MemorySnapshot {
  readonly observations: readonly ObservationRecord[];
}

/**
 * A skill's track record, reduced to the quantities the tracker's public API
 * exposes. Deliberately not the tracker's internal record shape: that shape is
 * free to grow, and this file must keep loading when it does.
 */
export interface SkillEvidence {
  readonly skill: string;
  readonly attempts: number;
  readonly successes: number;
  readonly meanDurationMs: number;
}

export interface ReliabilitySnapshot {
  readonly skills: readonly SkillEvidence[];
}

export interface Snapshot {
  readonly version: number;
  /** When the snapshot was taken, from a `Clock`. */
  readonly savedAt: number;
  readonly memory: MemorySnapshot;
  readonly reliability: ReliabilitySnapshot;
}

/** A snapshot holding nothing, which is what a first run legitimately has. */
export function emptySnapshot(savedAt = 0): Snapshot {
  return {
    version: SCHEMA_VERSION,
    savedAt,
    memory: { observations: [] },
    reliability: { skills: [] },
  };
}

/**
 * Parse arbitrary decoded JSON into a snapshot.
 *
 * Tolerant in one direction only: unknown extra fields are ignored, and an
 * absent section is read as empty, so a supported older file and a file
 * written by a slightly richer build both load. Intolerant of everything else,
 * including an unknown version and a field of the wrong type.
 */
export function decodeSnapshot(raw: unknown, source: string): Snapshot {
  const root = requireObject(raw, source, 'snapshot');
  const version = requireNumber(root['version'], source, 'version');
  if (!Number.isInteger(version)) {
    throw new SnapshotFormatError(
      source,
      `version must be an integer, got ${version}`,
    );
  }
  if (version < MIN_SUPPORTED_SCHEMA_VERSION || version > SCHEMA_VERSION) {
    throw new SnapshotVersionError(
      source,
      version,
      MIN_SUPPORTED_SCHEMA_VERSION,
      SCHEMA_VERSION,
    );
  }

  const savedAtRaw = root['savedAt'];
  const savedAt =
    savedAtRaw === undefined ? 0 : requireNumber(savedAtRaw, source, 'savedAt');

  return {
    version,
    savedAt,
    memory: decodeMemory(root['memory'], source),
    reliability: decodeReliability(root['reliability'], source),
  };
}

function decodeMemory(raw: unknown, source: string): MemorySnapshot {
  if (raw === undefined || raw === null) return { observations: [] };
  const section = requireObject(raw, source, 'memory');
  const list = section['observations'];
  if (list === undefined || list === null) return { observations: [] };
  if (!Array.isArray(list)) {
    throw new SnapshotFormatError(
      source,
      'memory.observations must be an array',
    );
  }
  return {
    observations: list.map((entry, i) =>
      decodeObservation(entry, source, `memory.observations[${i}]`),
    ),
  };
}

function decodeObservation(
  raw: unknown,
  source: string,
  where: string,
): ObservationRecord {
  const entry = requireObject(raw, source, where);
  return {
    block: decodeBlock(entry['block'], source, `${where}.block`),
    provenance: decodeProvenance(entry['provenance'], source, where),
    sensedAt: requireNumber(entry['sensedAt'], source, `${where}.sensedAt`),
  };
}

function decodeBlock(raw: unknown, source: string, where: string): BlockInfo {
  const block = requireObject(raw, source, where);
  const position = requireObject(
    block['position'],
    source,
    `${where}.position`,
  );
  const lightLevel = block['lightLevel'];
  const hardness = block['hardness'];
  return {
    name: requireString(block['name'], source, `${where}.name`),
    position: {
      x: requireNumber(position['x'], source, `${where}.position.x`),
      y: requireNumber(position['y'], source, `${where}.position.y`),
      z: requireNumber(position['z'], source, `${where}.position.z`),
    },
    solid: requireBoolean(block['solid'], source, `${where}.solid`),
    // Spread rather than assign, so an absent optional stays absent instead of
    // becoming an explicit undefined, which exactOptionalPropertyTypes forbids.
    ...(lightLevel === undefined || lightLevel === null
      ? {}
      : {
          lightLevel: requireNumber(lightLevel, source, `${where}.lightLevel`),
        }),
    ...(hardness === undefined || hardness === null
      ? {}
      : { hardness: requireNumber(hardness, source, `${where}.hardness`) }),
  };
}

function decodeProvenance(
  raw: unknown,
  source: string,
  where: string,
): Provenance {
  const value = requireString(raw, source, `${where}.provenance`);
  const known = PROVENANCE.find((p) => p === value);
  if (known === undefined) {
    throw new SnapshotFormatError(
      source,
      `${where}.provenance is not a known provenance: ${JSON.stringify(value)}`,
    );
  }
  return known;
}

function decodeReliability(raw: unknown, source: string): ReliabilitySnapshot {
  if (raw === undefined || raw === null) return { skills: [] };
  const section = requireObject(raw, source, 'reliability');
  const list = section['skills'];
  if (list === undefined || list === null) return { skills: [] };
  if (!Array.isArray(list)) {
    throw new SnapshotFormatError(
      source,
      'reliability.skills must be an array',
    );
  }
  return {
    skills: list.map((entry, i) =>
      decodeEvidence(entry, source, `reliability.skills[${i}]`),
    ),
  };
}

function decodeEvidence(
  raw: unknown,
  source: string,
  where: string,
): SkillEvidence {
  const entry = requireObject(raw, source, where);
  const skill = requireString(entry['skill'], source, `${where}.skill`);
  const attempts = requireCount(entry['attempts'], source, `${where}.attempts`);
  const successes = requireCount(
    entry['successes'],
    source,
    `${where}.successes`,
  );
  if (successes > attempts) {
    throw new SnapshotFormatError(
      source,
      `${where} claims ${successes} successes in ${attempts} attempts`,
    );
  }
  const mean = entry['meanDurationMs'];
  return {
    skill,
    attempts,
    successes,
    meanDurationMs:
      mean === undefined || mean === null
        ? 0
        : requireNumber(mean, source, `${where}.meanDurationMs`),
  };
}

function requireObject(
  value: unknown,
  source: string,
  where: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotFormatError(source, `${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, source: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SnapshotFormatError(
      source,
      `${where} must be a finite number, got ${describe(value)}`,
    );
  }
  return value;
}

/** A non-negative integer, used for attempt and success counts. */
function requireCount(value: unknown, source: string, where: string): number {
  const n = requireNumber(value, source, where);
  if (!Number.isInteger(n) || n < 0) {
    throw new SnapshotFormatError(
      source,
      `${where} must be a non-negative integer, got ${n}`,
    );
  }
  return n;
}

function requireString(value: unknown, source: string, where: string): string {
  if (typeof value !== 'string') {
    throw new SnapshotFormatError(
      source,
      `${where} must be a string, got ${describe(value)}`,
    );
  }
  return value;
}

function requireBoolean(
  value: unknown,
  source: string,
  where: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new SnapshotFormatError(
      source,
      `${where} must be a boolean, got ${describe(value)}`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
