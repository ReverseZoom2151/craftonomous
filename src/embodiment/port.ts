import type { Vec3Like } from './geometry.js';
import type {
  BlockInfo,
  BodyState,
  ChatMessage,
  ContainerView,
  EntityInfo,
  ItemStack,
  SoundEvent,
} from './types.js';

/**
 * Raw, ungated access to the world.
 *
 * **Only a perception adapter may hold one of these.** Skills, planners,
 * the MCP surface and the reference agent must never receive a `SensorPort`
 * directly: an ungated read would bypass the profile and leave the ledger
 * reporting a fiction. This is the load-bearing constraint of the codebase,
 * and it is enforced by construction: nothing above the gate is handed one.
 *
 * Implementations: a mineflayer binding for live play, and an in-memory fake
 * for tests.
 */
export interface SensorPort {
  body(): BodyState;

  /** The block at a coordinate, or undefined when that area is not loaded. */
  blockAt(position: Vec3Like): BlockInfo | undefined;

  /** Every entity the substrate currently knows about. */
  entities(): readonly EntityInfo[];

  inventory(): readonly ItemStack[];

  /** Items currently equipped, keyed by slot name. */
  equipment(): Readonly<Record<string, ItemStack | undefined>>;

  /**
   * Whether solid matter stands between two points.
   *
   * This is what gives the `fair-play` profile teeth. Without a real
   * implementation the profile is a contract with no enforcer.
   */
  isOccluded(from: Vec3Like, to: Vec3Like): boolean;

  /** Blocks matching a name within a radius, nearest first. Ungated. */
  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit: number;
  }): readonly BlockInfo[];

  /**
   * Sound events the body has registered since the last call, oldest first.
   * **Draining clears the buffer**: what is returned here will not be returned
   * again.
   *
   * A drain, rather than a getter, because a sound is an event and not a state.
   * A getter that kept answering with the last sound would let a caller hear one
   * creeper forever, and the ledger would count a hearing read every time. A
   * since-cursor read was the alternative and was rejected: it obliges the port
   * to keep history for a reader that may never come back, and once the buffer
   * is bounded (as it must be for a long run) the cursor quietly starts lying
   * about what it skipped. Draining puts the bound where it can be seen.
   *
   * Optional: a substrate that cannot report sound simply does not implement
   * this, and callers must read that as silence rather than as "nothing was
   * audible". Optional also keeps this addition compatible with every
   * `SensorPort` written before hearing existed.
   */
  drainSounds?(): readonly SoundEvent[];

  /**
   * Chat messages received since the last call, oldest first. Draining clears
   * the buffer, for the same reasons as {@link SensorPort.drainSounds}.
   *
   * These are raw utterances. Nothing here is checked, and nothing here is
   * true merely because it was said; that judgement belongs above the gate.
   */
  drainChat?(): readonly ChatMessage[];
}

/** The outcome of an actuation attempt, before skill-level interpretation. */
export interface ActuationOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Actions the body can take.
 *
 * Actuation is not gated: doing a thing is not knowing a thing, and an agent
 * is always permitted to act on the world. What it may *learn* is governed by
 * the perception gate.
 */
export interface ActuatorPort {
  moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome>;

  lookAt(position: Vec3Like): Promise<ActuationOutcome>;

  dig(
    position: Vec3Like,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome>;

  placeBlock(
    against: Vec3Like,
    face: Vec3Like,
    item: string,
  ): Promise<ActuationOutcome>;

  equip(item: string, destination?: string): Promise<ActuationOutcome>;

  consume(item: string): Promise<ActuationOutcome>;

  attack(entityId: number): Promise<ActuationOutcome>;

  dropItem(item: string, count?: number): Promise<ActuationOutcome>;

  craft(
    recipe: string,
    count: number,
    options?: { readonly craftingTable?: Vec3Like },
  ): Promise<ActuationOutcome>;

  openContainer(position: Vec3Like): Promise<ContainerView | undefined>;

  closeContainer(): Promise<void>;

  withdraw(item: string, count: number): Promise<ActuationOutcome>;

  deposit(item: string, count: number): Promise<ActuationOutcome>;

  chat(message: string): Promise<ActuationOutcome>;

  stop(): Promise<void>;
}

/** A connected body: sensors plus actuators, with a lifecycle. */
export interface EmbodimentPort {
  readonly sensors: SensorPort;
  readonly actuators: ActuatorPort;
  readonly connected: boolean;
  disconnect(): Promise<void>;
}
