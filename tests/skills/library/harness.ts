import type { ActuationOutcome, ActuatorPort } from '../../../src/embodiment/port.js';
import type { Vec3Like } from '../../../src/embodiment/geometry.js';
import { blockCentre, distance, key } from '../../../src/embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../../../src/embodiment/types.js';
import type { Observed } from '../../../src/observation/observed.js';
import { PerceptionLedger } from '../../../src/perception/ledger.js';
import type { PerceptionReport } from '../../../src/perception/ledger.js';
import { FAIR_PLAY } from '../../../src/perception/profile.js';
import type { PerceptionProfile } from '../../../src/perception/profile.js';
import type { WorldView } from '../../../src/perception/world-view.js';
import { ManualClock } from '../../../src/runtime/clock.js';
import { silentLogger } from '../../../src/runtime/logger.js';
import type {
  PreconditionResult,
  Skill,
  SkillContext,
} from '../../../src/skills/types.js';

/**
 * Offline doubles for the two ports a skill is allowed to touch.
 *
 * These live here rather than in `src/embodiment/fake/` on purpose: the point
 * of the library tests is to pin down what a skill does given a *world it can
 * only read through `WorldView`*, so the double is written against that
 * interface and nothing else. In particular there is no `SensorPort` anywhere
 * in this file, and a block absent from `blocks` is *unknown* rather than air.
 */

const DEFAULT_BODY: BodyState = {
  position: { x: 0, y: 64, z: 0 },
  eyePosition: { x: 0, y: 65.6, z: 0 },
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

export function block(
  name: string,
  position: Vec3Like,
  solid = name !== 'air',
): BlockInfo {
  return { name, position, solid };
}

export function entity(
  id: number,
  name: string,
  position: Vec3Like,
  extra: Partial<EntityInfo> = {},
): EntityInfo {
  return { id, name, kind: 'mob', position, ...extra };
}

export interface FakeWorldInit {
  readonly body?: Partial<BodyState>;
  readonly inventory?: readonly ItemStack[];
  readonly blocks?: readonly BlockInfo[];
  readonly entities?: readonly EntityInfo[];
  readonly profile?: PerceptionProfile;
}

export class FakeWorld implements WorldView {
  readonly profile: PerceptionProfile;
  readonly clock = new ManualClock(1_000);
  readonly ledger = new PerceptionLedger();

  body_: BodyState;
  items: ItemStack[];
  readonly blocks = new Map<string, BlockInfo>();
  entities: EntityInfo[];
  container: ContainerView | undefined;

  /** Every read that went through this view, for order-of-operations checks. */
  readonly reads: string[] = [];

  constructor(init: FakeWorldInit = {}) {
    this.profile = init.profile ?? FAIR_PLAY;
    this.body_ = { ...DEFAULT_BODY, ...init.body };
    this.items = [...(init.inventory ?? [])];
    this.entities = [...(init.entities ?? [])];
    for (const b of init.blocks ?? []) this.blocks.set(key(b.position), b);
  }

  #observe<T>(what: string, value: T): Observed<T> {
    this.reads.push(what);
    this.ledger.record('sight');
    return { value, provenance: 'sight', sensedAt: this.clock.now() };
  }

  body(): Observed<BodyState> {
    this.reads.push('body');
    this.ledger.record('proprioception');
    return { value: this.body_, provenance: 'proprioception', sensedAt: this.clock.now() };
  }

  inventory(): Observed<readonly ItemStack[]> {
    this.reads.push('inventory');
    this.ledger.record('proprioception');
    return { value: [...this.items], provenance: 'proprioception', sensedAt: this.clock.now() };
  }

  blockAt(position: Vec3Like): Observed<BlockInfo> | undefined {
    const found = this.blocks.get(key(position));
    if (!found) {
      this.reads.push(`blockAt:${key(position)}:unknown`);
      return undefined;
    }
    return this.#observe(`blockAt:${key(position)}`, found);
  }

  nearbyEntities(options?: {
    readonly maxDistance?: number;
    readonly kinds?: readonly string[];
  }): readonly Observed<EntityInfo>[] {
    const max = options?.maxDistance ?? Number.POSITIVE_INFINITY;
    const kinds = options?.kinds;
    return this.entities
      .filter((e) => distance(this.body_.position, e.position) <= max)
      .filter((e) => (kinds ? kinds.includes(e.kind) : true))
      .sort(
        (a, b) =>
          distance(this.body_.position, a.position) -
          distance(this.body_.position, b.position),
      )
      .map((e) => this.#observe(`entity:${e.id}`, e));
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit?: number;
  }): readonly Observed<BlockInfo>[] {
    const wanted = new Set(options.names);
    return [...this.blocks.values()]
      .filter((b) => wanted.has(b.name))
      .filter(
        (b) =>
          distance(this.body_.position, blockCentre(b.position)) <= options.maxDistance,
      )
      .sort(
        (a, b) =>
          distance(this.body_.position, blockCentre(a.position)) -
          distance(this.body_.position, blockCentre(b.position)),
      )
      .slice(0, options.limit ?? 16)
      .map((b) => this.#observe(`findBlocks:${b.name}`, b));
  }

  openContainer(): Observed<ContainerView> | undefined {
    if (!this.container) return undefined;
    return this.#observe('openContainer', this.container);
  }

  recollections(): readonly Observed<BlockInfo>[] {
    return [];
  }

  report(): PerceptionReport {
    return this.ledger.report();
  }

  /* -------------------- mutators, used by the fake body ------------- */

  setBlock(b: BlockInfo): void {
    this.blocks.set(key(b.position), b);
  }

  /** Make a cell unknown again — as if the agent had never sensed it. */
  forget(position: Vec3Like): void {
    this.blocks.delete(key(position));
  }

  moveBody(position: Vec3Like): void {
    this.body_ = {
      ...this.body_,
      position,
      eyePosition: { x: position.x, y: position.y + 1.6, z: position.z },
    };
  }

  give(name: string, count: number): void {
    const existing = this.items.find((s) => s.name === name);
    if (existing) {
      this.items = this.items.map((s) =>
        s.name === name ? { ...s, count: s.count + count } : s,
      );
    } else {
      this.items = [...this.items, { name, count }];
    }
  }

  take(name: string, count: number): number {
    const existing = this.items.find((s) => s.name === name);
    if (!existing) return 0;
    const taken = Math.min(existing.count, count);
    this.items = this.items
      .map((s) => (s.name === name ? { ...s, count: s.count - taken } : s))
      .filter((s) => s.count > 0);
    return taken;
  }

  countItem(name: string): number {
    return this.items
      .filter((s) => s.name === name)
      .reduce((total, s) => total + s.count, 0);
  }

  setContainerContents(contents: readonly ItemStack[]): void {
    if (!this.container) return;
    this.container = { ...this.container, contents: [...contents] };
  }
}

export const OK: ActuationOutcome = { ok: true };
export function refuse(detail: string): ActuationOutcome {
  return { ok: false, detail };
}

type Handler<Args extends unknown[], R> = (...args: Args) => R | Promise<R>;

export interface FakeBodyOptions {
  moveTo?: Handler<[Vec3Like, number | undefined], ActuationOutcome>;
  lookAt?: Handler<[Vec3Like], ActuationOutcome>;
  dig?: Handler<[Vec3Like], ActuationOutcome>;
  placeBlock?: Handler<[Vec3Like, Vec3Like, string], ActuationOutcome>;
  equip?: Handler<[string, string | undefined], ActuationOutcome>;
  consume?: Handler<[string], ActuationOutcome>;
  attack?: Handler<[number], ActuationOutcome>;
  dropItem?: Handler<[string, number | undefined], ActuationOutcome>;
  craft?: Handler<[string, number, Vec3Like | undefined], ActuationOutcome>;
  openContainer?: Handler<[Vec3Like], ContainerView | undefined>;
  withdraw?: Handler<[string, number], ActuationOutcome>;
  deposit?: Handler<[string, number], ActuationOutcome>;
  chat?: Handler<[string], ActuationOutcome>;
  /** What a dug block yields, keyed by block name. Defaults to itself. */
  drops?: Readonly<Record<string, string>>;
}

/**
 * A body that actually changes the fake world, so a skill's read-back checks
 * are exercised rather than short-circuited. Any handler can be overridden to
 * stage a failure.
 */
export class FakeBody implements ActuatorPort {
  readonly calls: string[] = [];

  constructor(
    private readonly world: FakeWorld,
    private readonly options: FakeBodyOptions = {},
  ) {}

  #record(name: string): void {
    this.calls.push(name);
  }

  async moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    this.#record('moveTo');
    if (this.options.moveTo) return this.options.moveTo(position, options?.range);
    // Default body walks the whole way, landing on the target.
    this.world.moveBody(position);
    return OK;
  }

  async lookAt(position: Vec3Like): Promise<ActuationOutcome> {
    this.#record('lookAt');
    if (this.options.lookAt) return this.options.lookAt(position);
    return OK;
  }

  async dig(position: Vec3Like): Promise<ActuationOutcome> {
    this.#record('dig');
    if (this.options.dig) return this.options.dig(position);
    const existing = this.world.blockAt(position);
    if (!existing) return refuse('nothing there');
    const drop = this.options.drops?.[existing.value.name] ?? existing.value.name;
    this.world.setBlock(block('air', position, false));
    this.world.give(drop, 1);
    return OK;
  }

  async placeBlock(
    against: Vec3Like,
    face: Vec3Like,
    item: string,
  ): Promise<ActuationOutcome> {
    this.#record('placeBlock');
    if (this.options.placeBlock) return this.options.placeBlock(against, face, item);
    if (this.world.take(item, 1) < 1) return refuse('no such item');
    this.world.setBlock(
      block(item, { x: against.x + face.x, y: against.y + face.y, z: against.z + face.z }),
    );
    return OK;
  }

  async equip(item: string, destination?: string): Promise<ActuationOutcome> {
    this.#record('equip');
    if (this.options.equip) return this.options.equip(item, destination);
    return OK;
  }

  async consume(item: string): Promise<ActuationOutcome> {
    this.#record('consume');
    if (this.options.consume) return this.options.consume(item);
    this.world.take(item, 1);
    return OK;
  }

  async attack(entityId: number): Promise<ActuationOutcome> {
    this.#record('attack');
    if (this.options.attack) return this.options.attack(entityId);
    return OK;
  }

  async dropItem(item: string, count?: number): Promise<ActuationOutcome> {
    this.#record('dropItem');
    if (this.options.dropItem) return this.options.dropItem(item, count);
    this.world.take(item, count ?? 64);
    return OK;
  }

  async craft(
    recipe: string,
    count: number,
    options?: { readonly craftingTable?: Vec3Like },
  ): Promise<ActuationOutcome> {
    this.#record('craft');
    if (this.options.craft) return this.options.craft(recipe, count, options?.craftingTable);
    this.world.give(recipe, count);
    return OK;
  }

  async openContainer(position: Vec3Like): Promise<ContainerView | undefined> {
    this.#record('openContainer');
    const view = this.options.openContainer
      ? await this.options.openContainer(position)
      : ({ kind: 'chest', position, contents: [] } as ContainerView);
    this.world.container = view;
    return view;
  }

  async closeContainer(): Promise<void> {
    this.#record('closeContainer');
    this.world.container = undefined;
  }

  async withdraw(item: string, count: number): Promise<ActuationOutcome> {
    this.#record('withdraw');
    if (this.options.withdraw) return this.options.withdraw(item, count);
    const view = this.world.container;
    if (!view) return refuse('no container open');
    const available = view.contents
      .filter((s) => s.name === item)
      .reduce((t, s) => t + s.count, 0);
    const moved = Math.min(available, count);
    if (moved < 1) return refuse('the container has none of that');
    this.world.setContainerContents(
      view.contents
        .map((s) => (s.name === item ? { ...s, count: s.count - moved } : s))
        .filter((s) => s.count > 0),
    );
    this.world.give(item, moved);
    return OK;
  }

  async deposit(item: string, count: number): Promise<ActuationOutcome> {
    this.#record('deposit');
    if (this.options.deposit) return this.options.deposit(item, count);
    const view = this.world.container;
    if (!view) return refuse('no container open');
    const moved = this.world.take(item, count);
    if (moved < 1) return refuse('nothing to deposit');
    this.world.setContainerContents([...view.contents, { name: item, count: moved }]);
    return OK;
  }

  async chat(message: string): Promise<ActuationOutcome> {
    this.#record('chat');
    if (this.options.chat) return this.options.chat(message);
    return OK;
  }

  async stop(): Promise<void> {
    this.#record('stop');
  }
}

export interface Harness {
  readonly world: FakeWorld;
  readonly body: FakeBody;
  readonly ctx: SkillContext;
  readonly controller: AbortController;
}

export function harness(init: FakeWorldInit = {}, options: FakeBodyOptions = {}): Harness {
  const world = new FakeWorld(init);
  const body = new FakeBody(world, options);
  const controller = new AbortController();
  const ctx: SkillContext = {
    world,
    act: body,
    clock: world.clock,
    log: silentLogger,
    signal: controller.signal,
  };
  return { world, body, ctx, controller };
}

/** Run a skill's precondition, failing loudly when it does not declare one. */
export function precondition<I, O>(
  skill: Skill<I, O>,
  ctx: SkillContext,
  input: I,
): Promise<PreconditionResult> {
  if (!skill.precondition) throw new Error(`${skill.name} declares no precondition`);
  return skill.precondition(ctx, input);
}

/** Convenience: a position literal. */
export function at(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}
