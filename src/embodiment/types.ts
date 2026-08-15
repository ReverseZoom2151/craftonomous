import type { Vec3Like } from './geometry.js';

/** A block as the substrate reports it. */
export interface BlockInfo {
  /** Namespaced-free block name, e.g. `iron_ore`, `stone`. */
  readonly name: string;
  readonly position: Vec3Like;
  /** Whether the block obstructs movement and sight. */
  readonly solid: boolean;
  /** Light level 0-15 at this block, when known. */
  readonly lightLevel?: number;
  /** Hardness proxy; higher takes longer to dig. */
  readonly hardness?: number;
}

export type EntityKind = 'player' | 'mob' | 'animal' | 'item' | 'object' | 'other';

export interface EntityInfo {
  readonly id: number;
  /** Entity type name, e.g. `zombie`, `cow`. */
  readonly name: string;
  readonly kind: EntityKind;
  readonly position: Vec3Like;
  readonly health?: number;
  /** True when this entity is hostile to the agent. */
  readonly hostile?: boolean;
  /** Username, for players only. */
  readonly username?: string;
}

export interface ItemStack {
  readonly name: string;
  readonly count: number;
  /** Inventory slot index, when the stack is in a container or inventory. */
  readonly slot?: number;
}

/** The agent's own body. Always available by proprioception. */
export interface BodyState {
  readonly position: Vec3Like;
  /** Eye position, used as the origin for sight checks. */
  readonly eyePosition: Vec3Like;
  readonly health: number;
  readonly food: number;
  readonly oxygen: number;
  readonly onGround: boolean;
  readonly inWater: boolean;
  readonly inLava: boolean;
  readonly isBurning: boolean;
  /** Yaw and pitch in radians. */
  readonly yaw: number;
  readonly pitch: number;
  readonly dimension: string;
}

/** A sound heard without seeing its source. */
export interface SoundEvent {
  readonly name: string;
  /** Approximate origin. Bearing is meaningful; exact position may not be. */
  readonly approximatePosition: Vec3Like;
  readonly volume: number;
}

/** A chat message received from another party. */
export interface ChatMessage {
  readonly from: string;
  readonly text: string;
  /** True when whispered rather than broadcast. */
  readonly private: boolean;
}

/** A container the agent has opened. */
export interface ContainerView {
  readonly kind: 'chest' | 'furnace' | 'crafting_table' | 'other';
  readonly position: Vec3Like;
  readonly contents: readonly ItemStack[];
}
