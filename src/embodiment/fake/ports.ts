import type { Vec3Like } from '../geometry.js';
import { add, blockCentre, distance, floor, subtract } from '../geometry.js';
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
import type { PathLimits } from './pathfinding.js';
import { DEFAULT_LIMITS, planPath, standingPosition } from './pathfinding.js';
import { FakeWorld } from './world.js';

/** One attempted actuation, recorded whether or not it succeeded. */
export interface ActionRecord {
  readonly kind: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly detail?: string;
}

function ok(detail?: string): ActuationOutcome {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

function fail(detail: string): ActuationOutcome {
  return { ok: false, detail };
}

/**
 * Sensors over a {@link FakeWorld}.
 *
 * Ungated by construction, exactly like the live binding: it is the perception
 * gate's job to decide what an agent may learn, and this port's job to answer
 * honestly so the gate has something true to restrict.
 */
export class FakeSensorPort implements SensorPort {
  constructor(private readonly world: FakeWorld) {}

  body(): BodyState {
    return this.world.body();
  }

  blockAt(position: Vec3Like): BlockInfo | undefined {
    return this.world.getBlock(position);
  }

  entities(): readonly EntityInfo[] {
    return this.world.entities();
  }

  inventory(): readonly ItemStack[] {
    return this.world.inventory();
  }

  equipment(): Readonly<Record<string, ItemStack | undefined>> {
    return this.world.equipment();
  }

  isOccluded(from: Vec3Like, to: Vec3Like): boolean {
    return rayIsOccluded(from, to, (p) => this.world.isSolid(p));
  }

  /** Sounds since the last drain. See {@link SensorPort.drainSounds}. */
  drainSounds(): readonly SoundEvent[] {
    return this.world.drainSounds();
  }

  /** Chat since the last drain. See {@link SensorPort.drainChat}. */
  drainChat(): readonly ChatMessage[] {
    return this.world.drainChat();
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit: number;
  }): readonly BlockInfo[] {
    return this.world.findBlocks({
      origin: this.world.body().position,
      names: options.names,
      maxDistance: options.maxDistance,
      limit: options.limit,
    });
  }
}

/**
 * Actuators that really change the {@link FakeWorld}: digging removes a block
 * and yields its drop, moving teleports the body, crafting consumes inputs. A
 * skill exercised against this port is exercised end to end, offline and
 * deterministically, which is the only way skill reliability figures mean
 * anything before a server is involved.
 */
export class FakeActuatorPort implements ActuatorPort {
  readonly actions: ActionRecord[] = [];

  /** Reach limit for digging and placing, in blocks, as a vanilla client has. */
  reach = 4.5;

  /** How hard the pathfinder is allowed to work. Tests may tighten this. */
  pathLimits: PathLimits = DEFAULT_LIMITS;

  /**
   * Called once per step of a walk, before the body moves into the next cell.
   *
   * The seam that stands in for the passage of time. A real walk can be
   * interrupted halfway; without somewhere for the world to change mid-route,
   * a fake walk is atomic and the interruption path is untestable. Left unset
   * it costs nothing.
   */
  onStep?: (progress: {
    readonly step: number;
    readonly total: number;
    readonly at: Vec3Like;
  }) => void | Promise<void>;

  /** Chat lines the body has emitted, in order. */
  readonly chatLog: string[] = [];

  #openContainer: Vec3Like | undefined;
  #nextEntityId = 10_000;

  constructor(private readonly world: FakeWorld) {}

  #record(
    kind: string,
    args: Readonly<Record<string, unknown>>,
    outcome: ActuationOutcome,
  ): ActuationOutcome {
    this.actions.push({
      kind,
      args,
      ok: outcome.ok,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
    return outcome;
  }

  /**
   * Whether the body could touch a block from where it is standing.
   *
   * Now that the body genuinely walks, every actuator that implies reaching
   * something enforces this: digging, placing against a face, swinging at an
   * entity, and opening or using a container. Before, only `dig` did, which
   * made the fake more capable than a real body in exactly the way that lets a
   * broken skill pass offline and fail on a server. A skill that wants to dig
   * something far away must now walk to it first, which is what the server
   * would have demanded anyway.
   *
   * The slack of one block matches what `dig` has always allowed, standing in
   * for the difference between eye position and the corner of a hitbox.
   */
  #withinReach(target: Vec3Like): boolean {
    const eye = this.world.body().eyePosition;
    return distance(eye, blockCentre(target)) <= this.reach + 1;
  }

  /** Every recorded action of one kind, oldest first. */
  actionsOfKind(kind: string): readonly ActionRecord[] {
    return this.actions.filter((action) => action.kind === kind);
  }

  clearActions(): void {
    this.actions.length = 0;
  }

  /**
   * Walk to a position, or refuse.
   *
   * The route is planned over the voxel world with the same rules a real body
   * lives under (see `pathfinding.ts`) and then walked one cell at a time. A
   * target with no route is a failure, not a teleport; an abort stops the body
   * where it actually got to, because that is where a real body would be.
   */
  async moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    const args = { position, range: options?.range };
    if (isAborted(options?.signal)) {
      return this.#record('moveTo', args, fail('aborted'));
    }

    const self = this.world.body();
    const plan = planPath(this.world, self.position, position, {
      ...(options?.range === undefined ? {} : { range: options.range }),
      // A body held up by a fluid swims rather than walks. See `planPath`.
      swim: self.inWater || self.inLava,
      limits: this.pathLimits,
    });

    if (!plan.ok) {
      return this.#record('moveTo', args, fail(plan.detail));
    }

    const goalCell = floor(position);
    if (plan.steps.length === 0) {
      // Already there. Standing anywhere in the goal column counts as arrival,
      // so shuffle to the exact spot rather than reporting a move that the
      // body's own position would contradict.
      if (sameCell(floor(self.position), goalCell)) {
        this.world.setBody({ position });
      }
      return this.#record('moveTo', args, ok('already there'));
    }

    let walked = 0;
    for (const cell of plan.steps) {
      // Walking takes time on a real server, and things happen during it. This
      // is where that time goes: nothing by default, so the suite stays fast.
      await this.onStep?.({
        step: walked,
        total: plan.steps.length,
        at: this.world.body().position,
      });
      if (isAborted(options?.signal)) {
        // Leave the body where it got to. The log says how far that was, so a
        // partial move is visible rather than being reported as a whole one.
        return this.#record(
          'moveTo',
          args,
          fail(
            `aborted after ${walked} of ${plan.steps.length} steps at ${show(this.world.body().position)}`,
          ),
        );
      }
      // Within the goal cell the body may stand exactly where it was asked to,
      // since any point in a block column is a legal place to stand.
      const feet = sameCell(cell, goalCell) ? position : standingPosition(cell);
      this.world.setBody({ position: feet });
      walked += 1;
    }

    return this.#record(
      'moveTo',
      args,
      ok(`walked ${walked} steps to ${show(this.world.body().position)}`),
    );
  }

  async lookAt(position: Vec3Like): Promise<ActuationOutcome> {
    const eye = this.world.body().eyePosition;
    const d = subtract(position, eye);
    const yaw = Math.atan2(-d.x, -d.z);
    const horizontal = Math.sqrt(d.x * d.x + d.z * d.z);
    const pitch = Math.atan2(d.y, horizontal);
    this.world.setBody({ yaw, pitch });
    return this.#record('lookAt', { position }, ok());
  }

  async dig(
    position: Vec3Like,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    const args = { position };
    if (options?.signal?.aborted === true) {
      return this.#record('dig', args, fail('aborted'));
    }
    const block = this.world.getBlock(position);
    if (block === undefined) {
      return this.#record('dig', args, fail('block is not loaded'));
    }
    if (block.name === 'air') {
      return this.#record('dig', args, fail('nothing to dig'));
    }
    if (!this.#withinReach(position)) {
      return this.#record('dig', args, fail('out of reach'));
    }
    this.world.setBlock(position, 'air', false);
    this.world.addItem(block.name, 1);
    return this.#record('dig', args, ok(`dug ${block.name}`));
  }

  async placeBlock(
    against: Vec3Like,
    face: Vec3Like,
    item: string,
  ): Promise<ActuationOutcome> {
    const args = { against, face, item };
    const target = floor(add(against, face));
    if (this.world.countItem(item) < 1) {
      return this.#record('placeBlock', args, fail(`no ${item} in inventory`));
    }
    const anchor = this.world.getBlock(against);
    if (anchor === undefined || !anchor.solid) {
      return this.#record('placeBlock', args, fail('nothing to place against'));
    }
    const existing = this.world.getBlock(target);
    if (existing !== undefined && existing.solid) {
      return this.#record('placeBlock', args, fail('target is occupied'));
    }
    if (!this.#withinReach(against) || !this.#withinReach(target)) {
      return this.#record('placeBlock', args, fail('out of reach'));
    }
    this.world.removeItem(item, 1);
    this.world.setBlock(target, item);
    return this.#record('placeBlock', args, ok());
  }

  async equip(item: string, destination?: string): Promise<ActuationOutcome> {
    const args = { item, destination };
    if (this.world.countItem(item) < 1) {
      return this.#record('equip', args, fail(`no ${item} in inventory`));
    }
    this.world.setEquipment(destination ?? 'hand', { name: item, count: 1 });
    return this.#record('equip', args, ok());
  }

  async consume(item: string): Promise<ActuationOutcome> {
    const args = { item };
    if (!this.world.removeItem(item, 1)) {
      return this.#record('consume', args, fail(`no ${item} in inventory`));
    }
    const body = this.world.body();
    this.world.setBody({ food: Math.min(20, body.food + 4) });
    return this.#record('consume', args, ok());
  }

  async attack(entityId: number): Promise<ActuationOutcome> {
    const args = { entityId };
    const entity = this.world.getEntity(entityId);
    if (entity === undefined) {
      return this.#record('attack', args, fail('no such entity'));
    }
    if (
      distance(this.world.body().eyePosition, entity.position) >
      this.reach + 1
    ) {
      return this.#record('attack', args, fail('out of reach'));
    }
    const health = (entity.health ?? 20) - 5;
    if (health <= 0) {
      this.world.removeEntity(entityId);
      return this.#record('attack', args, ok('killed'));
    }
    this.world.updateEntity(entityId, { health });
    return this.#record('attack', args, ok());
  }

  async dropItem(item: string, count = 1): Promise<ActuationOutcome> {
    const args = { item, count };
    if (!this.world.removeItem(item, count)) {
      return this.#record('dropItem', args, fail(`not enough ${item}`));
    }
    this.world.addEntity({
      id: this.#nextEntityId++,
      name: item,
      kind: 'item',
      position: this.world.body().position,
    });
    return this.#record('dropItem', args, ok());
  }

  async craft(
    recipe: string,
    count: number,
    options?: { readonly craftingTable?: Vec3Like },
  ): Promise<ActuationOutcome> {
    const args = { recipe, count, craftingTable: options?.craftingTable };
    if (count <= 0)
      return this.#record('craft', args, fail('count must be positive'));

    const known = this.world.getRecipe(recipe);
    if (known === undefined) {
      return this.#record('craft', args, fail(`unknown recipe ${recipe}`));
    }
    if (known.requiresTable === true && options?.craftingTable === undefined) {
      return this.#record('craft', args, fail('a crafting table is required'));
    }
    for (const input of known.inputs) {
      if (this.world.countItem(input.name) < input.count * count) {
        return this.#record('craft', args, fail(`not enough ${input.name}`));
      }
    }
    for (const input of known.inputs) {
      this.world.removeItem(input.name, input.count * count);
    }
    const output = known.output ?? { name: recipe, count: 1 };
    this.world.addItem(output.name, output.count * count);
    return this.#record('craft', args, ok());
  }

  async openContainer(position: Vec3Like): Promise<ContainerView | undefined> {
    const view = this.world.getContainer(position);
    if (view === undefined) {
      this.#record('openContainer', { position }, fail('no container there'));
      return undefined;
    }
    if (!this.#withinReach(position)) {
      this.#record('openContainer', { position }, fail('out of reach'));
      return undefined;
    }
    this.#record('openContainer', { position }, ok(view.kind));
    this.#openContainer = floor(position);
    return view;
  }

  async closeContainer(): Promise<void> {
    this.#record('closeContainer', {}, ok());
    this.#openContainer = undefined;
  }

  async withdraw(item: string, count: number): Promise<ActuationOutcome> {
    return this.#transfer('withdraw', item, count);
  }

  async deposit(item: string, count: number): Promise<ActuationOutcome> {
    return this.#transfer('deposit', item, count);
  }

  #transfer(
    direction: 'withdraw' | 'deposit',
    item: string,
    count: number,
  ): ActuationOutcome {
    const args = { item, count };
    const open = this.#openContainer;
    if (open === undefined) {
      return this.#record(direction, args, fail('no container is open'));
    }
    // Walking away from a chest closes its window on a real server, so a
    // transfer from out of reach cannot happen and the window is dropped too.
    if (!this.#withinReach(open)) {
      this.#openContainer = undefined;
      return this.#record(
        direction,
        args,
        fail('the container is out of reach'),
      );
    }
    const moved = this.world.transferContainer(open, item, count, direction);
    return this.#record(
      direction,
      args,
      moved ? ok() : fail(`could not ${direction} ${count} ${item}`),
    );
  }

  async chat(message: string): Promise<ActuationOutcome> {
    this.chatLog.push(message);
    return this.#record('chat', { message }, ok());
  }

  async stop(): Promise<void> {
    this.#record('stop', {}, ok());
  }
}

/** A fake body: sensors and actuators over one world, with a lifecycle. */
export class FakeEmbodiment implements EmbodimentPort {
  readonly sensors: FakeSensorPort;
  readonly actuators: FakeActuatorPort;
  #connected = true;

  constructor(readonly world: FakeWorld = new FakeWorld()) {
    this.sensors = new FakeSensorPort(world);
    this.actuators = new FakeActuatorPort(world);
  }

  get connected(): boolean {
    return this.#connected;
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
  }
}

/** Convenience constructor matching the shape callers expect from `connect`. */
export function createFakeEmbodiment(
  world: FakeWorld = new FakeWorld(),
): FakeEmbodiment {
  return new FakeEmbodiment(world);
}

/**
 * Whether a signal has been raised. A function rather than an inline read so
 * that a check before a walk does not narrow away the checks made during it:
 * the whole point is that the answer can change between steps.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sameCell(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Compact coordinates for an action-log detail. */
function show(p: Vec3Like): string {
  const round = (n: number): number => Math.round(n * 100) / 100;
  return `${round(p.x)},${round(p.y)},${round(p.z)}`;
}
