/**
 * Craftonomous: an agent-agnostic Minecraft embodiment and evaluation
 * substrate.
 *
 * Note what is deliberately not exported from the package root: `SensorPort`
 * implementations. The raw sensor interface is a type, and the mineflayer and
 * fake bindings that satisfy it live behind `craftonomous/embodiment`, so that
 * reaching past the perception gate is something a caller has to do on
 * purpose rather than by autocomplete.
 */

/* Observation contract */
export type { Observed, Recalled } from './observation/observed.js';
export {
  combine,
  isFairlyObtained,
  mapObserved,
  observe,
  recall,
} from './observation/observed.js';
export type { Provenance } from './observation/provenance.js';
export {
  FAIR_PLAY_PROVENANCE,
  PROVENANCE,
  isFairPlay,
} from './observation/provenance.js';

/* Perception */
export type { SightCheck } from './perception/gate.js';
export { PerceptionDenied, PerceptionGate } from './perception/gate.js';
export type { PerceptionReport } from './perception/ledger.js';
export { PerceptionLedger } from './perception/ledger.js';
export type { PerceptionProfile } from './perception/profile.js';
export {
  BUILTIN_PROFILES,
  FAIR_PLAY,
  OMNISCIENT,
  XRAY,
  profileByName,
} from './perception/profile.js';
export type { WorldView } from './perception/world-view.js';
export { PerceptionAdapter } from './perception/adapter.js';
export { WorldMemory } from './perception/memory.js';

/* Embodiment contracts and geometry */
export type {
  ActuationOutcome,
  ActuatorPort,
  EmbodimentPort,
  SensorPort,
} from './embodiment/port.js';
export type {
  BlockInfo,
  BodyState,
  ChatMessage,
  ContainerView,
  EntityInfo,
  EntityKind,
  ItemStack,
  SoundEvent,
} from './embodiment/types.js';
export type { Vec3Like } from './embodiment/geometry.js';
export * as geometry from './embodiment/geometry.js';
export { isOccluded, traverse } from './embodiment/raycast.js';

/* Skills */
export type {
  AnySkill,
  FailureKind,
  PreconditionResult,
  Skill,
  SkillContext,
  SkillResult,
} from './skills/types.js';
export {
  HOLDS,
  RETRYABLE_FAILURES,
  fail,
  fails,
  isRetryable,
  succeed,
} from './skills/types.js';
export {
  DuplicateSkill,
  SkillRegistry,
  UnknownSkill,
} from './skills/registry.js';
export type {
  ReliabilityStats,
  RetirementPolicy,
  SkillOutcome,
} from './skills/reliability.js';
export {
  DEFAULT_RETIREMENT,
  ReliabilityTracker,
  wilsonLowerBound,
} from './skills/reliability.js';
export { SkillRunner } from './skills/runner.js';
export * from './skills/reflex/index.js';
export { CORE_SKILLS, registerCoreSkills } from './skills/library/index.js';

/* Runtime */
export type { Clock } from './runtime/clock.js';
export { ManualClock, systemClock } from './runtime/clock.js';
export type { Logger, LogLevel, LogRecord } from './runtime/logger.js';
export { MemoryLogger, silentLogger } from './runtime/logger.js';
