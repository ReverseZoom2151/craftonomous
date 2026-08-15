import type { Vec3Like } from '../geometry.js';
import { add, distance, floor, subtract } from '../geometry.js';
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
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../types.js';
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

  /** Every recorded action of one kind, oldest first. */
  actionsOfKind(kind: string): readonly ActionRecord[] {
    return this.actions.filter((action) => action.kind === kind);
  }

  clearActions(): void {
    this.actions.length = 0;
  }

  async moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    const args = { position, range: options?.range };
    if (options?.signal?.aborted === true) {
      return this.#record('moveTo', args, fail('aborted'));
    }
    const range = options?.range ?? 0;
    const from = this.world.body().position;
    const total = distance(from, position);
    // Stopping short by `range` is what a pathfinder goal does, and skills that
    // ask for a range and then assert on exact arrival deserve to notice.
    const target =
      range > 0 && total > range
        ? add(from, scaleTo(subtract(position, from), total - range))
        : position;
    this.world.setBody({ position: target });
    return this.#record('moveTo', args, ok());
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
    if (distance(this.world.body().eyePosition, position) > this.reach + 1) {
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
    if (count <= 0) return this.#record('craft', args, fail('count must be positive'));

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
    this.#record(
      'openContainer',
      { position },
      view === undefined ? fail('no container there') : ok(view.kind),
    );
    if (view === undefined) return undefined;
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
export function createFakeEmbodiment(world: FakeWorld = new FakeWorld()): FakeEmbodiment {
  return new FakeEmbodiment(world);
}

/** Scale a vector to a given length, tolerating the zero vector. */
function scaleTo(v: Vec3Like, len: number): Vec3Like {
  const current = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (current === 0) return { x: 0, y: 0, z: 0 };
  const k = len / current;
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}
