/**
 * Durable state.
 *
 * Without this module every run starts ignorant and every reliability
 * judgement is thrown away when the process ends, which makes long-horizon
 * behaviour impossible to study.
 */

export {
  PersistenceError,
  SnapshotFormatError,
  SnapshotVersionError,
} from './errors.js';
export type {
  MemorySnapshot,
  ObservationRecord,
  ReliabilitySnapshot,
  SkillEvidence,
  Snapshot,
} from './snapshot.js';
export {
  decodeSnapshot,
  emptySnapshot,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from './snapshot.js';
export type { MemorySnapshotOptions } from './memory-codec.js';
export {
  DEFAULT_MAX_PERSISTED_OBSERVATIONS,
  restoreWorldMemory,
  snapshotWorldMemory,
  toObserved,
} from './memory-codec.js';
export {
  restoreReliability,
  snapshotReliability,
} from './reliability-codec.js';
export type { CaptureOptions, RestoreResult } from './capture.js';
export { applySnapshot, captureSnapshot } from './capture.js';
export type { FileStoreOptions } from './file-store.js';
export { FileStore } from './file-store.js';
