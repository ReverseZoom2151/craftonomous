import type { Vec3Like } from '../embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../embodiment/types.js';
import type { Observed } from '../observation/observed.js';
import type { PerceptionReport } from './ledger.js';
import type { PerceptionProfile } from './profile.js';

/**
 * The only way anything above the gate learns about the world.
 *
 * Every method returns provenance-tagged observations. A `undefined` return
 * means *not known*, which is not the same as *not there*: a block outside
 * sight range is unknown, and an agent that treats unknown as absent is making
 * an inference it should be made to state.
 */
export interface WorldView {
  readonly profile: PerceptionProfile;

  /** Always available: the agent's own body. */
  body(): Observed<BodyState>;

  /** Always available: what the agent is carrying. */
  inventory(): Observed<readonly ItemStack[]>;

  /**
   * The block at a coordinate, if currently sensed. Falls back to memory when
   * the block was seen before and has not expired, tagged accordingly.
   */
  blockAt(position: Vec3Like): Observed<BlockInfo> | undefined;

  /** Entities currently sensed, nearest first. */
  nearbyEntities(options?: {
    readonly maxDistance?: number;
    readonly kinds?: readonly string[];
  }): readonly Observed<EntityInfo>[];

  /**
   * Blocks matching a name that the agent can currently sense, or recalls
   * having sensed. Subject to range and occlusion under the active profile.
   */
  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit?: number;
  }): readonly Observed<BlockInfo>[];

  /** The container currently open, if any. */
  openContainer(): Observed<ContainerView> | undefined;

  /** Everything the agent recalls but cannot currently sense. */
  recollections(): readonly Observed<BlockInfo>[];

  /** How this agent has come by its knowledge so far. */
  report(): PerceptionReport;
}
