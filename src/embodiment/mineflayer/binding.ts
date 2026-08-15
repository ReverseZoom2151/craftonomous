import type { Vec3Like } from '../geometry.js';
import { add, floor } from '../geometry.js';
import type {
  ActuationOutcome,
  ActuatorPort,
  EmbodimentPort,
  SensorPort,
} from '../port.js';
import { isOccluded as rayIsOccluded } from '../raycast.js';
import type {
  BlockInfo,
  BodyState,
  ChatMessage,
  ContainerView,
  EntityInfo,
  ItemStack,
  SoundEvent,
} from '../types.js';
import type { Logger } from '../../runtime/logger.js';
import { silentLogger } from '../../runtime/logger.js';
import { toAuthError } from './auth-errors.js';
import { classifyEntity } from './taxonomy.js';

/**
 * Live binding to a mineflayer bot.
 *
 * mineflayer's own typings are loose and version-dependent, and letting them
 * spread would put `any` into the perception path where correctness is the whole
 * point. So this file is the quarantine: everything upstream is described by the
 * narrow structural interfaces below, narrowed to our own types on the way out,
 * and nothing untyped escapes past the module boundary.
 *
 * Everything here needs a server to exercise. Logic that can be checked offline
 * lives in `raycast.ts` and `taxonomy.ts` instead, and is tested there.
 */

// --------------------------------------------------------------------------
// Narrow structural view of the upstream library.
// --------------------------------------------------------------------------

interface MfVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface MfBlock {
  readonly name: string;
  readonly position: MfVec3;
  /** `block` for full cubes, `empty` for air, `null` for non-colliding. */
  readonly boundingBox?: string | null;
  readonly hardness?: number | null;
  readonly light?: number;
  readonly type?: number;
}

interface MfEntity {
  readonly id: number;
  readonly name?: string | undefined;
  readonly username?: string | undefined;
  readonly type?: string | undefined;
  readonly position: MfVec3;
  readonly health?: number | undefined;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly onGround?: boolean;
  readonly isInWater?: boolean;
  readonly isInLava?: boolean;
  readonly metadata?: readonly unknown[];
}

interface MfItem {
  readonly name: string;
  readonly count: number;
  readonly slot?: number;
  readonly type?: number;
  readonly metadata?: number;
}

interface MfWindow {
  readonly type?: string;
  slots: readonly (MfItem | null)[];
  containerItems?: () => MfItem[];
}

interface MfRecipe {
  readonly result?: { readonly count?: number };
}

interface MfPathfinder {
  goto(goal: unknown): Promise<void>;
  setGoal(goal: unknown): void;
  stop(): void;
  setMovements?: (movements: unknown) => void;
}

interface MfRegistryItem {
  readonly id: number;
  readonly name: string;
}

interface MfRegistry {
  readonly itemsByName: Readonly<Record<string, MfRegistryItem | undefined>>;
  readonly blocksByName: Readonly<Record<string, MfRegistryItem | undefined>>;
}

/**
 * The subset of a mineflayer bot this binding relies on. Written by hand rather
 * than imported so that an upstream signature drift shows up here as a compile
 * error in one file, not as a runtime surprise three layers up.
 */
export interface MineflayerBotLike {
  readonly entity: MfEntity | undefined;
  readonly entities: Readonly<Record<string, MfEntity | undefined>>;
  readonly health?: number;
  readonly food?: number;
  readonly oxygenLevel?: number;
  readonly game?: { readonly dimension?: string };
  readonly registry?: MfRegistry;
  readonly pathfinder?: MfPathfinder;
  readonly currentWindow?: MfWindow | null;

  readonly inventory: {
    items(): MfItem[];
    readonly slots: readonly (MfItem | null)[];
  };

  blockAt(position: MfVec3): MfBlock | null;
  findBlocks(options: {
    matching: number | readonly number[];
    maxDistance: number;
    count: number;
  }): MfVec3[];

  dig(block: MfBlock): Promise<void>;
  stopDigging(): void;
  placeBlock(reference: MfBlock, face: MfVec3): Promise<void>;
  equip(item: MfItem | number, destination?: string | null): Promise<void>;
  consume(): Promise<void>;
  attack(entity: MfEntity): void;
  toss(itemType: number, metadata: number | null, count: number): Promise<void>;
  craft(recipe: MfRecipe, count: number, table?: MfBlock | null): Promise<void>;
  recipesFor(
    itemId: number,
    metadata: number | null,
    minResultCount: number | null,
    craftingTable: MfBlock | null,
  ): MfRecipe[];
  openContainer(block: MfBlock): Promise<MfWindow>;
  closeWindow(window: MfWindow): void;
  withdraw?: (itemType: number, metadata: number | null, count: number) => Promise<void>;
  chat(message: string): void;
  /**
   * Ask the server to respawn a dead body. Optional because older mineflayer
   * builds do not expose it, and a body that cannot respawn should say so
   * rather than appear to hang.
   */
  respawn?: () => void;
  lookAt(point: MfVec3, force?: boolean): Promise<void>;
  clearControlStates?: () => void;
  quit(reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

/** Factory for whatever vector type the upstream library expects to receive. */
export type Vec3Factory = (x: number, y: number, z: number) => MfVec3;

// --------------------------------------------------------------------------
// Mapping upstream shapes to ours.
// --------------------------------------------------------------------------

const EYE_HEIGHT = 1.62;

function point(v: MfVec3): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Whether a block obstructs sight. `boundingBox === 'block'` is the substrate's
 * own answer and is preferred; the name check only catches the case where the
 * field is missing entirely.
 */
export function blockIsSolid(block: MfBlock | null | undefined): boolean {
  if (block === null || block === undefined) return false;
  if (block.boundingBox !== undefined && block.boundingBox !== null) {
    return block.boundingBox === 'block';
  }
  return block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air';
}

function toBlockInfo(block: MfBlock | null | undefined): BlockInfo | undefined {
  if (block === null || block === undefined) return undefined;
  return {
    name: stripNamespace(block.name),
    position: floor(point(block.position)),
    solid: blockIsSolid(block),
    ...(typeof block.light === 'number' ? { lightLevel: block.light } : {}),
    ...(typeof block.hardness === 'number' ? { hardness: block.hardness } : {}),
  };
}

function toEntityInfo(entity: MfEntity): EntityInfo {
  const { kind, hostile } = classifyEntity({
    name: entity.name,
    type: entity.type,
    username: entity.username,
  });
  return {
    id: entity.id,
    name: stripNamespace(entity.name ?? entity.type ?? 'unknown'),
    kind,
    position: point(entity.position),
    hostile,
    ...(typeof entity.health === 'number' ? { health: entity.health } : {}),
    ...(entity.username === undefined ? {} : { username: entity.username }),
  };
}

function toItemStack(item: MfItem): ItemStack {
  return {
    name: stripNamespace(item.name),
    count: item.count,
    ...(typeof item.slot === 'number' ? { slot: item.slot } : {}),
  };
}

function stripNamespace(name: string): string {
  return name.includes(':') ? (name.split(':').at(-1) ?? name) : name;
}

/** Equipment slot names, in the order mineflayer lays out the inventory window. */
const EQUIPMENT_SLOTS: ReadonlyArray<readonly [string, number]> = [
  ['head', 5],
  ['torso', 6],
  ['legs', 7],
  ['feet', 8],
  ['off-hand', 45],
];

// --------------------------------------------------------------------------
// Sensors.
// --------------------------------------------------------------------------

/**
 * How many undrained sound events or chat messages this binding will hold.
 *
 * The server pushes events whether or not anything is listening, so the buffer
 * must be bounded or a long session next to a mob farm ends as a heap dump.
 * When it is full the oldest event is dropped: a sound nobody collected for two
 * hundred events is no longer news.
 */
export const EVENT_BUFFER_LIMIT = 256;

function pushBounded<T>(buffer: T[], event: T): void {
  buffer.push(event);
  while (buffer.length > EVENT_BUFFER_LIMIT) buffer.shift();
}

/** Narrow an upstream event argument to a point, or give up on it. */
function asPoint(value: unknown): Vec3Like | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, z } = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return undefined;
  }
  return { x, y, z };
}

export class MineflayerSensorPort implements SensorPort {
  readonly #sounds: SoundEvent[] = [];
  readonly #chat: ChatMessage[] = [];

  constructor(
    private readonly bot: MineflayerBotLike,
    private readonly vec3: Vec3Factory,
  ) {
    this.#subscribe();
  }

  /**
   * Buffer sound and chat as the server delivers them.
   *
   * Upstream hands these listeners `unknown` by our own choice of signature, so
   * every field is narrowed here and nothing loosely typed escapes the class. An
   * event we cannot make sense of is dropped rather than guessed at: a sound
   * with no position gives no bearing, and a bearing is the whole of what
   * hearing provides.
   */
  #subscribe(): void {
    this.bot.on('soundEffectHeard', (...args: unknown[]) => {
      const name = args[0];
      const at = asPoint(args[1]);
      if (typeof name !== 'string' || at === undefined) return;
      pushBounded(this.#sounds, {
        name: stripNamespace(name),
        approximatePosition: at,
        volume: typeof args[2] === 'number' ? args[2] : 1,
      });
    });

    // Hardcoded effects arrive as a numeric id with no name attached. The id is
    // kept verbatim rather than mapped, because a wrong name is worse than an
    // opaque one and the bearing is what a listener is really after.
    this.bot.on('hardcodedSoundEffectHeard', (...args: unknown[]) => {
      const id = args[0];
      const at = asPoint(args[2]);
      if (typeof id !== 'number' || at === undefined) return;
      pushBounded(this.#sounds, {
        name: `hardcoded_${id}`,
        approximatePosition: at,
        volume: typeof args[3] === 'number' ? args[3] : 1,
      });
    });

    const message = (isPrivate: boolean) => (...args: unknown[]) => {
      const from = args[0];
      const text = args[1];
      if (typeof from !== 'string' || typeof text !== 'string') return;
      pushBounded(this.#chat, { from, text, private: isPrivate });
    };
    this.bot.on('chat', message(false));
    this.bot.on('whisper', message(true));
  }

  /** Sounds since the last drain. See {@link SensorPort.drainSounds}. */
  drainSounds(): readonly SoundEvent[] {
    return this.#sounds.splice(0, this.#sounds.length);
  }

  /** Chat since the last drain. See {@link SensorPort.drainChat}. */
  drainChat(): readonly ChatMessage[] {
    return this.#chat.splice(0, this.#chat.length);
  }

  body(): BodyState {
    const entity = this.bot.entity;
    const position = entity === undefined ? { x: 0, y: 0, z: 0 } : point(entity.position);
    return {
      position,
      eyePosition: { x: position.x, y: position.y + EYE_HEIGHT, z: position.z },
      health: this.bot.health ?? 0,
      food: this.bot.food ?? 0,
      oxygen: this.bot.oxygenLevel ?? 20,
      onGround: entity?.onGround ?? false,
      inWater: entity?.isInWater ?? false,
      inLava: entity?.isInLava ?? false,
      isBurning: isBurning(entity),
      yaw: entity?.yaw ?? 0,
      pitch: entity?.pitch ?? 0,
      dimension: this.bot.game?.dimension ?? 'overworld',
    };
  }

  blockAt(position: Vec3Like): BlockInfo | undefined {
    const p = floor(position);
    return toBlockInfo(this.bot.blockAt(this.vec3(p.x, p.y, p.z)));
  }

  entities(): readonly EntityInfo[] {
    const out: EntityInfo[] = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (entity === undefined) continue;
      // The bot's own entity is proprioception, not sight; it is excluded here
      // so it cannot be double-counted as a sighting of somebody else.
      if (this.bot.entity !== undefined && entity.id === this.bot.entity.id) continue;
      out.push(toEntityInfo(entity));
    }
    return out;
  }

  inventory(): readonly ItemStack[] {
    return this.bot.inventory.items().map(toItemStack);
  }

  equipment(): Readonly<Record<string, ItemStack | undefined>> {
    const slots = this.bot.inventory.slots;
    const out: Record<string, ItemStack | undefined> = {};
    for (const [name, index] of EQUIPMENT_SLOTS) {
      const item = slots[index];
      out[name] = item === null || item === undefined ? undefined : toItemStack(item);
    }
    return out;
  }

  isOccluded(from: Vec3Like, to: Vec3Like): boolean {
    return rayIsOccluded(from, to, (p) =>
      blockIsSolid(this.bot.blockAt(this.vec3(p.x, p.y, p.z))),
    );
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit: number;
  }): readonly BlockInfo[] {
    const registry = this.bot.registry;
    if (registry === undefined) return [];
    const ids: number[] = [];
    for (const name of options.names) {
      const block = registry.blocksByName[stripNamespace(name)];
      if (block !== undefined) ids.push(block.id);
    }
    if (ids.length === 0) return [];
    const points = this.bot.findBlocks({
      matching: ids,
      maxDistance: options.maxDistance,
      count: options.limit,
    });
    const out: BlockInfo[] = [];
    for (const p of points) {
      const info = toBlockInfo(this.bot.blockAt(p));
      if (info !== undefined) out.push(info);
    }
    return out;
  }
}

/** Entity metadata bit 0 flags "on fire" in every protocol version we target. */
function isBurning(entity: MfEntity | undefined): boolean {
  const flags = entity?.metadata?.[0];
  return typeof flags === 'number' && (flags & 0x01) !== 0;
}

// --------------------------------------------------------------------------
// Actuators.
// --------------------------------------------------------------------------

function ok(detail?: string): ActuationOutcome {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

function fail(detail: string): ActuationOutcome {
  return { ok: false, detail };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Goal constructors from mineflayer-pathfinder, captured at connect time. */
export interface PathfinderGoals {
  near(x: number, y: number, z: number, range: number): unknown;
  block(x: number, y: number, z: number): unknown;
}

export class MineflayerActuatorPort implements ActuatorPort {
  #openWindow: MfWindow | undefined;

  constructor(
    private readonly bot: MineflayerBotLike,
    private readonly vec3: Vec3Factory,
    private readonly goals: PathfinderGoals | undefined,
    private readonly log: Logger,
  ) {}

  async moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    const pathfinder = this.bot.pathfinder;
    const goals = this.goals;
    if (pathfinder === undefined || goals === undefined) {
      return fail('pathfinder is not loaded');
    }
    if (options?.signal?.aborted === true) return fail('aborted');

    const range = options?.range ?? 1;
    const target = floor(position);
    const goal =
      range <= 0
        ? goals.block(target.x, target.y, target.z)
        : goals.near(position.x, position.y, position.z, range);

    const signal = options?.signal;
    const abort = () => {
      pathfinder.stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await pathfinder.goto(goal);
      return signal?.aborted === true ? fail('aborted') : ok();
    } catch (error) {
      if (signal?.aborted === true) return fail('aborted');
      return fail(describe(error));
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async lookAt(position: Vec3Like): Promise<ActuationOutcome> {
    try {
      await this.bot.lookAt(this.vec3(position.x, position.y, position.z), true);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async dig(
    position: Vec3Like,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    if (options?.signal?.aborted === true) return fail('aborted');
    const p = floor(position);
    const block = this.bot.blockAt(this.vec3(p.x, p.y, p.z));
    if (block === null) return fail('block is not loaded');
    if (block.name === 'air') return fail('nothing to dig');

    const signal = options?.signal;
    const abort = () => {
      this.bot.stopDigging();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.bot.dig(block);
      return signal?.aborted === true ? fail('aborted') : ok(stripNamespace(block.name));
    } catch (error) {
      if (signal?.aborted === true) return fail('aborted');
      return fail(describe(error));
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async placeBlock(
    against: Vec3Like,
    face: Vec3Like,
    item: string,
  ): Promise<ActuationOutcome> {
    const anchorPoint = floor(against);
    const anchor = this.bot.blockAt(
      this.vec3(anchorPoint.x, anchorPoint.y, anchorPoint.z),
    );
    if (anchor === null) return fail('nothing to place against');

    const equipped = await this.equip(item, 'hand');
    if (!equipped.ok) return equipped;

    try {
      await this.bot.placeBlock(anchor, this.vec3(face.x, face.y, face.z));
      this.log.debug('placed block', { item, at: add(anchorPoint, face) });
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async equip(item: string, destination?: string): Promise<ActuationOutcome> {
    const wanted = stripNamespace(item);
    const held = this.bot.inventory.items().find((i) => stripNamespace(i.name) === wanted);
    if (held === undefined) return fail(`no ${wanted} in inventory`);
    try {
      await this.bot.equip(held, destination ?? 'hand');
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async consume(item: string): Promise<ActuationOutcome> {
    const equipped = await this.equip(item, 'hand');
    if (!equipped.ok) return equipped;
    try {
      await this.bot.consume();
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async attack(entityId: number): Promise<ActuationOutcome> {
    const entity = this.bot.entities[String(entityId)];
    if (entity === undefined) return fail('no such entity');
    try {
      this.bot.attack(entity);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async dropItem(item: string, count = 1): Promise<ActuationOutcome> {
    const wanted = stripNamespace(item);
    const held = this.bot.inventory.items().find((i) => stripNamespace(i.name) === wanted);
    if (held === undefined || held.type === undefined) {
      return fail(`no ${wanted} in inventory`);
    }
    try {
      await this.bot.toss(held.type, null, count);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async craft(
    recipe: string,
    count: number,
    options?: { readonly craftingTable?: Vec3Like },
  ): Promise<ActuationOutcome> {
    const registry = this.bot.registry;
    if (registry === undefined) return fail('registry is not loaded');
    const wanted = registry.itemsByName[stripNamespace(recipe)];
    if (wanted === undefined) return fail(`unknown item ${recipe}`);

    let table: MfBlock | null = null;
    if (options?.craftingTable !== undefined) {
      const t = floor(options.craftingTable);
      table = this.bot.blockAt(this.vec3(t.x, t.y, t.z));
    }

    const candidates = this.bot.recipesFor(wanted.id, null, 1, table);
    const chosen = candidates[0];
    if (chosen === undefined) return fail(`no usable recipe for ${recipe}`);

    try {
      await this.bot.craft(chosen, count, table);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async openContainer(position: Vec3Like): Promise<ContainerView | undefined> {
    const p = floor(position);
    const block = this.bot.blockAt(this.vec3(p.x, p.y, p.z));
    if (block === null) return undefined;
    try {
      const window = await this.bot.openContainer(block);
      this.#openWindow = window;
      const items =
        window.containerItems?.() ??
        window.slots.filter((s): s is MfItem => s !== null && s !== undefined);
      return {
        kind: containerKind(block.name),
        position: p,
        contents: items.map(toItemStack),
      };
    } catch (error) {
      this.log.warn('could not open container', { error: describe(error) });
      return undefined;
    }
  }

  async closeContainer(): Promise<void> {
    const window = this.#openWindow;
    if (window === undefined) return;
    this.#openWindow = undefined;
    try {
      this.bot.closeWindow(window);
    } catch (error) {
      this.log.debug('closing container failed', { error: describe(error) });
    }
  }

  async withdraw(item: string, count: number): Promise<ActuationOutcome> {
    return this.#transfer('withdraw', item, count);
  }

  async deposit(item: string, count: number): Promise<ActuationOutcome> {
    return this.#transfer('deposit', item, count);
  }

  async #transfer(
    direction: 'withdraw' | 'deposit',
    item: string,
    count: number,
  ): Promise<ActuationOutcome> {
    const window = this.#openWindow as
      | (MfWindow & {
          deposit?: (t: number, m: number | null, c: number) => Promise<void>;
          withdraw?: (t: number, m: number | null, c: number) => Promise<void>;
        })
      | undefined;
    if (window === undefined) return fail('no container is open');

    const registry = this.bot.registry;
    const entry = registry?.itemsByName[stripNamespace(item)];
    if (entry === undefined) return fail(`unknown item ${item}`);

    const move = direction === 'withdraw' ? window.withdraw : window.deposit;
    if (move === undefined) return fail(`container does not support ${direction}`);
    try {
      await move.call(window, entry.id, null, count);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async chat(message: string): Promise<ActuationOutcome> {
    try {
      this.bot.chat(message);
      return ok();
    } catch (error) {
      return fail(describe(error));
    }
  }

  async stop(): Promise<void> {
    try {
      this.bot.pathfinder?.stop();
      this.bot.pathfinder?.setGoal(null);
    } catch {
      // A pathfinder that refuses to stop is not a reason to leave the body
      // digging as well.
    }
    try {
      this.bot.stopDigging();
    } catch {
      // Not digging.
    }
    this.bot.clearControlStates?.();
  }
}

function containerKind(name: string): ContainerView['kind'] {
  const n = stripNamespace(name);
  if (n.includes('chest') || n.includes('barrel') || n.includes('shulker')) return 'chest';
  if (n.includes('furnace') || n === 'smoker' || n === 'blast_furnace') return 'furnace';
  if (n === 'crafting_table') return 'crafting_table';
  return 'other';
}

// --------------------------------------------------------------------------
// Connection.
// --------------------------------------------------------------------------

/**
 * Mojang enforces **6 session joins per 30 seconds per account**. A reconnect
 * loop that ignores this will get the account temporarily suspended, and the
 * docs further note that a high volume of *errors* can itself trigger a
 * suspension that typically clears only after 24 hours. So a tight retry loop
 * against a failing server is strictly worse than a slow one.
 *
 * Two constants below encode that limit. Do not lower them:
 * - {@link MIN_RETRY_DELAY_MS} is a hard floor on the first retry delay, five
 *   seconds, so five retries can never fit inside one 30-second window.
 * - {@link MAX_JOIN_ATTEMPTS} caps attempts at 5 rather than 6, leaving one
 *   join of headroom for whatever else is using the account.
 */
export const MIN_RETRY_DELAY_MS = 5_000;

/** See {@link MIN_RETRY_DELAY_MS}. One below Mojang's limit of 6 per 30s. */
export const MAX_JOIN_ATTEMPTS = 5;

export interface ReconnectPolicy {
  readonly enabled: boolean;
  /** Clamped to {@link MAX_JOIN_ATTEMPTS}. */
  readonly maxAttempts: number;
  /** Clamped up to {@link MIN_RETRY_DELAY_MS}. */
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  maxAttempts: MAX_JOIN_ATTEMPTS,
  initialDelayMs: MIN_RETRY_DELAY_MS,
  maxDelayMs: 60_000,
  factor: 2,
};

export interface ConnectOptions {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly version?: string;
  /**
   * `microsoft` delegates the MSA -> Xbox Live -> XSTS -> Minecraft token chain
   * to `prismarine-auth` via mineflayer. We do not hand-roll any part of it; we
   * only translate its failures (see `auth-errors.ts`).
   */
  readonly auth?: 'offline' | 'microsoft';
  readonly password?: string;
  /** Milliseconds to wait for the spawn event before giving up on an attempt. */
  readonly spawnTimeoutMs?: number;
  readonly reconnect?: Partial<ReconnectPolicy>;
  readonly logger?: Logger;
  /** Load mineflayer-pathfinder. Off only for a bot that must not move. */
  readonly usePathfinder?: boolean;
}

/**
 * Backoff delay for attempt `n` (0-based), floored at {@link MIN_RETRY_DELAY_MS}
 * and capped by the policy.
 *
 * Pure, so the join schedule can be checked against Mojang's rate limit without
 * waiting five seconds per assertion.
 */
export function backoffDelay(attempt: number, policy: ReconnectPolicy): number {
  const base = Math.max(MIN_RETRY_DELAY_MS, policy.initialDelayMs);
  const factor = Math.max(1, policy.factor);
  const raw = base * factor ** Math.max(0, attempt);
  return Math.min(Math.max(policy.maxDelayMs, MIN_RETRY_DELAY_MS), raw);
}

export class MineflayerEmbodiment implements EmbodimentPort {
  readonly sensors: MineflayerSensorPort;
  readonly actuators: MineflayerActuatorPort;
  readonly #intentListeners = new Set<() => void>();
  #connected = true;

  constructor(
    private readonly bot: MineflayerBotLike,
    vec3: Vec3Factory,
    goals: PathfinderGoals | undefined,
    private readonly log: Logger = silentLogger,
  ) {
    this.sensors = new MineflayerSensorPort(bot, vec3);
    this.actuators = new MineflayerActuatorPort(bot, vec3, goals, log);
    bot.on('end', () => {
      this.#connected = false;
      this.log.info('bot connection ended');
    });
  }

  get connected(): boolean {
    return this.#connected;
  }

  /**
   * Be told when this body is torn down on purpose.
   *
   * A session supervisor needs to tell a deliberate teardown from a dropped
   * socket, and the socket itself cannot tell it: both arrive as `end`. Wire
   * `SessionSupervisor.noteIntentionalDisconnect` here and the distinction is
   * made where the intent actually is. Returns an unsubscribe function.
   */
  whenIntentionallyDisconnected(listener: () => void): () => void {
    this.#intentListeners.add(listener);
    return () => {
      this.#intentListeners.delete(listener);
    };
  }

  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    for (const listener of this.#intentListeners) listener();
    try {
      await this.actuators.stop();
    } catch {
      // Best effort: we are leaving anyway.
    }
    this.bot.quit('disconnect');
  }

  /** Alias of {@link disconnect}, for callers that think of it as closing. */
  async close(): Promise<void> {
    await this.disconnect();
  }
}

interface MineflayerModuleLike {
  createBot(options: Record<string, unknown>): unknown;
}

interface PathfinderModuleLike {
  pathfinder: unknown;
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalBlock: new (x: number, y: number, z: number) => unknown;
  };
}

interface Vec3ModuleLike {
  Vec3: new (x: number, y: number, z: number) => MfVec3;
}

interface PluginLoaderLike {
  loadPlugin(plugin: unknown): void;
}

/**
 * Connect to a server, retrying with exponential backoff.
 *
 * Resolves only once the bot has spawned: a bot that has connected but not
 * spawned has no body, and handing one back would give callers a port whose
 * every sensor lies about the world.
 *
 * Retries are deliberately slow. See {@link MIN_RETRY_DELAY_MS} for the join
 * rate limit they exist to respect. An authentication failure aborts the loop
 * outright: bad credentials do not become good ones on the third attempt, and
 * hammering a failing sign-in is itself grounds for a temporary suspension.
 *
 * Not implemented: Mojang publishes SHA-1 hashes of blocked server addresses at
 * `https://sessionserver.mojang.com/blockedservers`. We do not consult it, so a
 * blocked host fails at join time with whatever the server says.
 */
export async function connect(options: ConnectOptions): Promise<EmbodimentPort> {
  const log = options.logger ?? silentLogger;
  const requested: ReconnectPolicy = { ...DEFAULT_RECONNECT, ...options.reconnect };
  const policy: ReconnectPolicy = {
    ...requested,
    maxAttempts: Math.min(MAX_JOIN_ATTEMPTS, Math.max(1, requested.maxAttempts)),
    initialDelayMs: Math.max(MIN_RETRY_DELAY_MS, requested.initialDelayMs),
  };
  const attempts = policy.enabled ? policy.maxAttempts : 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1, policy);
      log.warn('retrying connection', { attempt, delayMs: delay });
      await sleep(delay);
    }
    try {
      return await attemptConnect(options, log);
    } catch (error) {
      const authError = toAuthError(error);
      if (authError !== undefined) {
        log.error('authentication failed', {
          code: authError.code,
          guidance: authError.guidance,
        });
        throw authError;
      }
      lastError = error;
      log.error('connection attempt failed', { attempt, error: describe(error) });
    }
  }
  throw new Error(
    `could not connect to ${options.host}:${options.port ?? 25565}: ${describe(lastError)}`,
  );
}

async function attemptConnect(
  options: ConnectOptions,
  log: Logger,
): Promise<EmbodimentPort> {
  const mineflayer = (await import('mineflayer')) as unknown as MineflayerModuleLike;
  const vec3Module = (await import('vec3')) as unknown as Vec3ModuleLike;
  const vec3: Vec3Factory = (x, y, z) => new vec3Module.Vec3(x, y, z);

  const raw = mineflayer.createBot({
    host: options.host,
    port: options.port ?? 25565,
    username: options.username,
    auth: options.auth ?? 'offline',
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  const bot = raw as MineflayerBotLike;

  let goals: PathfinderGoals | undefined;
  if (options.usePathfinder !== false) {
    try {
      const pf = (await import('mineflayer-pathfinder')) as unknown as PathfinderModuleLike;
      (raw as PluginLoaderLike).loadPlugin(pf.pathfinder);
      goals = {
        near: (x, y, z, range) => new pf.goals.GoalNear(x, y, z, range),
        block: (x, y, z) => new pf.goals.GoalBlock(x, y, z),
      };
    } catch (error) {
      log.warn('pathfinder unavailable; movement will be refused', {
        error: describe(error),
      });
    }
  }

  await waitForSpawn(bot, options.spawnTimeoutMs ?? 60_000);
  log.info('spawned', { host: options.host, username: options.username });
  return new MineflayerEmbodiment(bot, vec3, goals, log);
}

function waitForSpawn(bot: MineflayerBotLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener?.('spawn', onSpawn);
      bot.removeListener?.('error', onError);
      bot.removeListener?.('kicked', onKicked);
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(describe(error)));
    };
    const onSpawn = () => {
      finish();
    };
    const onError = (...args: unknown[]) => {
      finish(args[0] ?? new Error('unknown connection error'));
    };
    const onKicked = (...args: unknown[]) => {
      finish(new Error(`kicked: ${describe(args[0])}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${timeoutMs}ms waiting for spawn`));
    }, timeoutMs);

    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('kicked', onKicked);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
