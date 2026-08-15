export type {
  ConnectOptions,
  MineflayerBotLike,
  PathfinderGoals,
  ReconnectPolicy,
  Vec3Factory,
} from './binding.js';
export {
  DEFAULT_RECONNECT,
  EVENT_BUFFER_LIMIT as MINEFLAYER_EVENT_BUFFER_LIMIT,
  MAX_JOIN_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  MineflayerActuatorPort,
  MineflayerEmbodiment,
  MineflayerSensorPort,
  backoffDelay,
  blockIsSolid,
  connect,
} from './binding.js';

export type {
  BodyStatus,
  LifecycleEvent,
  LifecycleListener,
  RespawnOutcome,
  SessionSupervisorOptions,
} from './lifecycle.js';
export { JOIN_WINDOW_MS, JoinBudget, SessionSupervisor } from './lifecycle.js';

export type { XstsErrorCode } from './auth-errors.js';
export {
  MinecraftAuthError,
  XSTS_GUIDANCE,
  extractXstsCode,
  toAuthError,
} from './auth-errors.js';

export type { EntityClassification } from './taxonomy.js';
export { classifyEntity, normaliseEntityName } from './taxonomy.js';
