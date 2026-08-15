import type { Vec3Like } from '../geometry.js';
import { distanceSquared, floor, key } from '../geometry.js';
import type {
  BlockInfo,
  BodyState,
  ChatMessage,
  ContainerView,
  EntityInfo,
  ItemStack,
  SoundEvent,
} from '../types.js';

/**
 * Names that are present but do not obstruct movement or sight. Used only as
 * the default when a caller does not state solidity explicitly; tests that care
 * should pass `solid` and not rely on this list growing.
 */
const NON_SOLID = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'grass',
  'tall_grass',
  'short_grass',
  'fern',
  'dead_bush',
  'torch',
  'wall_torch',
  'redstone_torch',
  'ladder',
  'vine',
  'snow',
  'seagrass',
  'kelp',
  'fire',
  'rail',
]);

export const AIR: BlockInfo = Object.freeze({
  name: 'air',
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  solid: false,
});

/** Optional per-block detail a test may want to assert on. */
export interface BlockOptions {
  readonly solid?: boolean;
  readonly hardness?: number;
  readonly lightLevel?: number;
}

/** A recipe the fake actuator knows how to execute. */
export interface FakeRecipe {
  /** Item names and counts consumed per craft. */
  readonly inputs: readonly ItemStack[];
  /** Items produced per craft. Defaults to one of the recipe's own name. */
  readonly output?: ItemStack;
  /** When true, `craft` fails unless a crafting table position is supplied. */
  readonly requiresTable?: boolean;
}

interface StoredBlock {
  readonly name: string;
  readonly solid: boolean;
  readonly hardness?: number;
  readonly lightLevel?: number;
}

interface StoredContainer {
  readonly kind: ContainerView['kind'];
  contents: ItemStack[];
}

const DEFAULT_BODY: BodyState = {
  position: { x: 0, y: 64, z: 0 },
  eyePosition: { x: 0, y: 65.62, z: 0 },
  health: 20,
  food: 20,
  oxygen: 20,
  onGround: true,
  inWater: false,
  inLava: false,
  isBurning: false,
  yaw: 0,
  pitch: 0,
  dimension: 'overworld',
};

/** Vertical offset from feet to eyes, matching a standing player. */
export const EYE_HEIGHT = 1.62;

/**
 * How many undrained sound events or chat messages a body will hold.
 *
 * Events arrive whether or not anybody is listening, so an unbounded buffer is
 * a memory leak with a long fuse: a bot left running overnight next to a mob
 * grinder would accumulate hundreds of thousands of sounds nobody ever asked
 * for. When the buffer is full the oldest event is dropped, because a stale
 * sound is the one least worth hearing.
 */
export const EVENT_BUFFER_LIMIT = 256;

/** Append to a bounded buffer, dropping the oldest entry when it is full. */
export function pushBounded<T>(buffer: T[], event: T, limit: number): void {
  buffer.push(event);
  while (buffer.length > limit) buffer.shift();
}

/**
 * A deterministic in-memory voxel world.
 *
 * No I/O, no clock, no randomness: everything a test asserts on is something a
 * test put there. Unset coordinates read as air, so terrain is described by what
 * it contains rather than by what it does not.
 */
export class FakeWorld {
  readonly #blocks = new Map<string, StoredBlock>();
  readonly #unloaded = new Set<string>();
  readonly #entities = new Map<number, EntityInfo>();
  readonly #containers = new Map<string, StoredContainer>();
  readonly #recipes = new Map<string, FakeRecipe>();
  readonly #sounds: SoundEvent[] = [];
  readonly #chat: ChatMessage[] = [];
  #inventory: ItemStack[] = [];
  #equipment: Record<string, ItemStack | undefined> = {};
  #body: BodyState = DEFAULT_BODY;

  // ---------------------------------------------------------------- blocks

  setBlock(position: Vec3Like, name: string, solid?: boolean): void {
    this.setBlockDetailed(position, name, solid === undefined ? {} : { solid });
  }

  setBlockDetailed(
    position: Vec3Like,
    name: string,
    options: BlockOptions = {},
  ): void {
    const k = key(position);
    this.#unloaded.delete(k);
    const stored: StoredBlock = {
      name,
      solid: options.solid ?? !NON_SOLID.has(name),
      ...(options.hardness === undefined ? {} : { hardness: options.hardness }),
      ...(options.lightLevel === undefined
        ? {}
        : { lightLevel: options.lightLevel }),
    };
    this.#blocks.set(k, stored);
  }

  /** Fill an inclusive box. Coordinates may be given in any order. */
  fill(from: Vec3Like, to: Vec3Like, name: string, solid?: boolean): void {
    const a = floor(from);
    const b = floor(to);
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x += 1) {
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y += 1) {
        for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z += 1) {
          this.setBlock({ x, y, z }, name, solid);
        }
      }
    }
  }

  /** Mark a coordinate as outside the loaded area, so it reads as unknown. */
  setUnloaded(position: Vec3Like): void {
    const k = key(position);
    this.#blocks.delete(k);
    this.#unloaded.add(k);
  }

  /** The block at a coordinate, or undefined when that area is not loaded. */
  getBlock(position: Vec3Like): BlockInfo | undefined {
    const p = floor(position);
    const k = key(p);
    if (this.#unloaded.has(k)) return undefined;
    const stored = this.#blocks.get(k);
    if (stored === undefined) return { name: 'air', position: p, solid: false };
    return {
      name: stored.name,
      position: p,
      solid: stored.solid,
      ...(stored.hardness === undefined ? {} : { hardness: stored.hardness }),
      ...(stored.lightLevel === undefined
        ? {}
        : { lightLevel: stored.lightLevel }),
    };
  }

  /**
   * Whether a coordinate obstructs sight. Unloaded coordinates count as clear:
   * an agent is not blocked by matter nobody has told it about.
   */
  isSolid(position: Vec3Like): boolean {
    return this.getBlock(position)?.solid ?? false;
  }

  /** Every named block within `maxDistance` of `origin`, nearest first. */
  findBlocks(options: {
    readonly origin: Vec3Like;
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit: number;
  }): BlockInfo[] {
    const wanted = new Set(options.names);
    const found: BlockInfo[] = [];
    const maxSquared = options.maxDistance * options.maxDistance;
    for (const [k, stored] of this.#blocks) {
      if (!wanted.has(stored.name)) continue;
      const position = parseKey(k);
      if (position === undefined) continue;
      if (distanceSquared(position, options.origin) > maxSquared) continue;
      found.push({
        name: stored.name,
        position,
        solid: stored.solid,
        ...(stored.hardness === undefined ? {} : { hardness: stored.hardness }),
        ...(stored.lightLevel === undefined
          ? {}
          : { lightLevel: stored.lightLevel }),
      });
    }
    found.sort(
      (a, b) =>
        distanceSquared(a.position, options.origin) -
        distanceSquared(b.position, options.origin),
    );
    return found.slice(0, Math.max(0, options.limit));
  }

  // -------------------------------------------------------------- entities

  addEntity(entity: EntityInfo): void {
    this.#entities.set(entity.id, entity);
  }

  removeEntity(id: number): boolean {
    return this.#entities.delete(id);
  }

  getEntity(id: number): EntityInfo | undefined {
    return this.#entities.get(id);
  }

  /** Replace an entity in place, e.g. after damage or movement. */
  updateEntity(id: number, patch: Partial<EntityInfo>): boolean {
    const existing = this.#entities.get(id);
    if (existing === undefined) return false;
    this.#entities.set(id, { ...existing, ...patch });
    return true;
  }

  entities(): readonly EntityInfo[] {
    return [...this.#entities.values()];
  }

  // ------------------------------------------------------------------ body

  body(): BodyState {
    return this.#body;
  }

  /**
   * Patch the body. Moving the feet without stating an eye position moves the
   * eyes with them, which is what every caller means and nobody remembers.
   */
  setBody(patch: Partial<BodyState>): void {
    const next: BodyState = { ...this.#body, ...patch };
    if (patch.position !== undefined && patch.eyePosition === undefined) {
      this.#body = {
        ...next,
        eyePosition: {
          x: patch.position.x,
          y: patch.position.y + EYE_HEIGHT,
          z: patch.position.z,
        },
      };
      return;
    }
    this.#body = next;
  }

  // ------------------------------------------------------------- inventory

  setInventory(items: readonly ItemStack[]): void {
    this.#inventory = items.map((item, index) => ({
      ...item,
      slot: item.slot ?? index,
    }));
  }

  inventory(): readonly ItemStack[] {
    return this.#inventory;
  }

  countItem(name: string): number {
    return this.#inventory
      .filter((item) => item.name === name)
      .reduce((total, item) => total + item.count, 0);
  }

  addItem(name: string, count = 1): void {
    if (count <= 0) return;
    const index = this.#inventory.findIndex((item) => item.name === name);
    const existing = index >= 0 ? this.#inventory[index] : undefined;
    if (existing !== undefined) {
      this.#inventory[index] = { ...existing, count: existing.count + count };
      return;
    }
    this.#inventory.push({ name, count, slot: this.#inventory.length });
  }

  /** Remove up to `count`; returns false and changes nothing when short. */
  removeItem(name: string, count = 1): boolean {
    if (count <= 0) return true;
    if (this.countItem(name) < count) return false;
    let remaining = count;
    for (let i = 0; i < this.#inventory.length && remaining > 0; i += 1) {
      const stack = this.#inventory[i];
      if (stack === undefined || stack.name !== name) continue;
      const taken = Math.min(stack.count, remaining);
      remaining -= taken;
      this.#inventory[i] = { ...stack, count: stack.count - taken };
    }
    this.#inventory = this.#inventory.filter((item) => item.count > 0);
    return true;
  }

  equipment(): Readonly<Record<string, ItemStack | undefined>> {
    return this.#equipment;
  }

  setEquipment(slot: string, item: ItemStack | undefined): void {
    this.#equipment = { ...this.#equipment, [slot]: item };
  }

  // ------------------------------------------------------------ containers

  setContainer(
    position: Vec3Like,
    kind: ContainerView['kind'],
    contents: readonly ItemStack[],
  ): void {
    this.#containers.set(key(position), { kind, contents: [...contents] });
  }

  getContainer(position: Vec3Like): ContainerView | undefined {
    const stored = this.#containers.get(key(position));
    if (stored === undefined) return undefined;
    return {
      kind: stored.kind,
      position: floor(position),
      contents: [...stored.contents],
    };
  }

  /** Move items between a container and the inventory. Returns false when short. */
  transferContainer(
    position: Vec3Like,
    name: string,
    count: number,
    direction: 'withdraw' | 'deposit',
  ): boolean {
    const stored = this.#containers.get(key(position));
    if (stored === undefined || count <= 0) return false;

    if (direction === 'withdraw') {
      const available = stored.contents
        .filter((item) => item.name === name)
        .reduce((total, item) => total + item.count, 0);
      if (available < count) return false;
      stored.contents = takeFrom(stored.contents, name, count);
      this.addItem(name, count);
      return true;
    }

    if (!this.removeItem(name, count)) return false;
    const index = stored.contents.findIndex((item) => item.name === name);
    const existing = index >= 0 ? stored.contents[index] : undefined;
    if (existing === undefined) stored.contents.push({ name, count });
    else stored.contents[index] = { ...existing, count: existing.count + count };
    return true;
  }

  // ---------------------------------------------------------------- events

  /**
   * Make a noise somewhere in the world. Nothing is filtered here: the world is
   * as loud as it is, and whether the agent hears it is the perception gate's
   * decision, not this world's.
   */
  emitSound(name: string, position: Vec3Like, volume = 1): void {
    pushBounded(
      this.#sounds,
      { name, approximatePosition: { ...position }, volume },
      EVENT_BUFFER_LIMIT,
    );
  }

  /** Have somebody say something to the agent. */
  emitChat(
    from: string,
    text: string,
    options: { readonly private?: boolean } = {},
  ): void {
    pushBounded(
      this.#chat,
      { from, text, private: options.private ?? false },
      EVENT_BUFFER_LIMIT,
    );
  }

  /** Sounds since the last drain, oldest first. Clears the buffer. */
  drainSounds(): readonly SoundEvent[] {
    return this.#sounds.splice(0, this.#sounds.length);
  }

  /** Chat since the last drain, oldest first. Clears the buffer. */
  drainChat(): readonly ChatMessage[] {
    return this.#chat.splice(0, this.#chat.length);
  }

  /** How much is waiting to be drained. For assertions about the bound. */
  pendingEvents(): { readonly sounds: number; readonly chat: number } {
    return { sounds: this.#sounds.length, chat: this.#chat.length };
  }

  // --------------------------------------------------------------- recipes

  addRecipe(name: string, recipe: FakeRecipe): void {
    this.#recipes.set(name, recipe);
  }

  getRecipe(name: string): FakeRecipe | undefined {
    return this.#recipes.get(name);
  }
}

function takeFrom(
  stacks: readonly ItemStack[],
  name: string,
  count: number,
): ItemStack[] {
  let remaining = count;
  const next: ItemStack[] = [];
  for (const stack of stacks) {
    if (stack.name !== name || remaining <= 0) {
      next.push(stack);
      continue;
    }
    const taken = Math.min(stack.count, remaining);
    remaining -= taken;
    if (stack.count - taken > 0) next.push({ ...stack, count: stack.count - taken });
  }
  return next;
}

function parseKey(k: string): Vec3Like | undefined {
  const parts = k.split(',');
  if (parts.length !== 3) return undefined;
  const [xs, ys, zs] = parts;
  if (xs === undefined || ys === undefined || zs === undefined) return undefined;
  const x = Number(xs);
  const y = Number(ys);
  const z = Number(zs);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return undefined;
  }
  return { x, y, z };
}
