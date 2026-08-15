export type {
  ConnectOptions,
  MineflayerBotLike,
  PathfinderGoals,
  ReconnectPolicy,
  Vec3Factory,
} from './binding.js';
export {
  DEFAULT_RECONNECT,
  MAX_JOIN_ATTEMPTS,
  MIN_RETRY_DELAY_MS,
  MineflayerActuatorPort,
  MineflayerEmbodiment,
  MineflayerSensorPort,
  backoffDelay,
  blockIsSolid,
  connect,
} from './binding.js';

export type { XstsErrorCode } from './auth-errors.js';
export {
  MinecraftAuthError,
  XSTS_GUIDANCE,
  extractXstsCode,
  toAuthError,
} from './auth-errors.js';

export type { EntityClassification } from './taxonomy.js';
export { classifyEntity, normaliseEntityName } from './taxonomy.js';
