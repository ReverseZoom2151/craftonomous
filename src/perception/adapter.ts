import type { Vec3Like } from '../embodiment/geometry.js';
import { blockCentre, distance, key } from '../embodiment/geometry.js';
import type { SensorPort } from '../embodiment/port.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../embodiment/types.js';
import type { Observed } from '../observation/observed.js';
import type { PerceptionGate, SightCheck } from './gate.js';
import type { PerceptionReport } from './ledger.js';
import type { WorldMemory } from './memory.js';
import type { PerceptionProfile } from './profile.js';
import type { WorldView } from './world-view.js';

/**
 * How many raw candidates to pull from the sensors per requested result.
 *
 * Occlusion throws most candidates away under `fair-play`, so asking for
 * exactly `limit` blocks would return far fewer than `limit` visible ones and
 * make the profile look like a shortage of ore rather than a shortage of sight.
 */
const CANDIDATE_OVERSAMPLE = 4;

/** Results returned by `findBlocks` when the caller does not say. */
const DEFAULT_FIND_LIMIT = 64;

export interface PerceptionAdapterOptions {
  /**
   * Where the currently open container comes from. Containers are opened
   * through the actuators, not the sensors, so the adapter cannot discover one
   * on its own; whoever wires the body supplies the lookup. Without it,
   * `openContainer()` always reports nothing open.
   */
  readonly containerSource?: () => ContainerView | undefined;
}

/**
 * The one and only place a {@link SensorPort} is allowed to live.
 *
 * **This is the only class in the codebase permitted to hold a `SensorPort`.**
 * Everything above it — skills, planners, the MCP surface, the reference agent
 * — receives a {@link WorldView} and nothing else. That is not a style
 * preference: an ungated read anywhere above this line would bypass the active
 * {@link PerceptionProfile} and leave the ledger reporting a fiction about what
 * the agent actually knew. The constraint is enforced by construction, because
 * nothing above the gate is ever handed the port to begin with.
 *
 * The adapter's job is narrow: take raw sensor data, put every fact through the
 * gate, remember what was seen, and fall back to memory when sight fails.
 */
export class PerceptionAdapter implements WorldView {
  readonly #sensors: SensorPort;
  readonly #gate: PerceptionGate;
  readonly #memory: WorldMemory;
  readonly #containerSource: (() => ContainerView | undefined) | undefined;

  constructor(
    sensors: SensorPort,
    gate: PerceptionGate,
    memory: WorldMemory,
    options: PerceptionAdapterOptions = {},
  ) {
    this.#sensors = sensors;
    this.#gate = gate;
    this.#memory = memory;
    this.#containerSource = options.containerSource;
  }

  get profile(): PerceptionProfile {
    return this.#gate.profile;
  }

  /** The agent's own body. Always known, by proprioception. */
  body(): Observed<BodyState> {
    return this.#gate.sense(this.#sensors.body(), 'proprioception');
  }

  /** What the agent is carrying. Always known, by proprioception. */
  inventory(): Observed<readonly ItemStack[]> {
    return this.#gate.sense(this.#sensors.inventory(), 'proprioception');
  }

  /**
   * The block at a coordinate: sighted if it can be seen right now, otherwise
   * recalled, otherwise unknown. `undefined` means *not known*, never *not
   * there*.
   */
  blockAt(position: Vec3Like): Observed<BlockInfo> | undefined {
    const sighted = this.#sight(position);
    if (sighted !== undefined) return sighted;
    return this.#recall(position);
  }

  /** Entities currently in sight, nearest first. */
  nearbyEntities(
    options: {
      readonly maxDistance?: number;
      readonly kinds?: readonly string[];
    } = {},
  ): readonly Observed<EntityInfo>[] {
    const eye = this.#eye();
    const maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
    const kinds = options.kinds;

    const ranked: { readonly entity: EntityInfo; readonly at: number }[] = [];
    for (const entity of this.#sensors.entities()) {
      if (kinds !== undefined && !matchesKind(entity, kinds)) continue;
      const at = distance(eye, entity.position);
      if (at > maxDistance) continue;
      if (!this.#gate.canSee(this.#check(eye, entity.position, at))) continue;
      ranked.push({ entity, at });
    }
    ranked.sort((a, b) => a.at - b.at);

    return ranked.map(({ entity }) => this.#gate.sense(entity, 'sight'));
  }

  /**
   * Blocks matching a name, sighted or recalled, nearest first.
   *
   * The sensors answer without regard to the profile, so every candidate is put
   * back through the gate exactly as {@link PerceptionAdapter.blockAt} does.
   * Recollections of matching blocks are unioned in, with a current sighting
   * always winning over a memory of the same position.
   */
  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit?: number;
  }): readonly Observed<BlockInfo>[] {
    const eye = this.#eye();
    const limit = options.limit ?? DEFAULT_FIND_LIMIT;
    if (limit <= 0) return [];
    const wanted = new Set(options.names);

    const found = new Map<string, { readonly at: number; readonly seen: Observed<BlockInfo> }>();

    const candidates = this.#sensors.findBlocks({
      names: options.names,
      maxDistance: options.maxDistance,
      limit: limit * CANDIDATE_OVERSAMPLE,
    });
    for (const candidate of candidates) {
      const centre = blockCentre(candidate.position);
      const at = distance(eye, centre);
      if (at > options.maxDistance) continue;
      const seen = this.#gate.sight(candidate, this.#check(eye, centre, at));
      if (seen === undefined) continue;
      this.#memory.remember(seen);
      found.set(key(candidate.position), { at, seen });
    }

    for (const remembered of this.#memory.all()) {
      const block = remembered.value;
      if (!wanted.has(block.name)) continue;
      const k = key(block.position);
      if (found.has(k)) continue;
      const at = distance(eye, blockCentre(block.position));
      if (at > options.maxDistance) continue;
      const recalled = this.#recall(block.position);
      if (recalled === undefined) continue;
      found.set(k, { at, seen: recalled });
    }

    return [...found.values()]
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((entry) => entry.seen);
  }

  /** The container currently open, if any. */
  openContainer(): Observed<ContainerView> | undefined {
    const container = this.#containerSource?.();
    if (container === undefined) return undefined;
    return this.#gate.sense(container, 'sight');
  }

  /**
   * Everything remembered that cannot be seen right now, each tagged with its
   * age. A block still in plain sight is not a recollection.
   */
  recollections(): readonly Observed<BlockInfo>[] {
    const eye = this.#eye();
    this.#memory.forgetExpired(this.#gate);

    const out: Observed<BlockInfo>[] = [];
    for (const remembered of this.#memory.all()) {
      const centre = blockCentre(remembered.value.position);
      const at = distance(eye, centre);
      if (this.#gate.canSee(this.#check(eye, centre, at))) continue;
      const recalled = this.#recall(remembered.value.position);
      if (recalled !== undefined) out.push(recalled);
    }
    return out;
  }

  /** How this agent has come by its knowledge so far. */
  report(): PerceptionReport {
    return this.#gate.ledger.report();
  }

  /** Sense a block at a position right now, remembering it if seen. */
  #sight(position: Vec3Like): Observed<BlockInfo> | undefined {
    const block = this.#sensors.blockAt(position);
    if (block === undefined) return undefined;
    const eye = this.#eye();
    const centre = blockCentre(position);
    const seen = this.#gate.sight(block, this.#check(eye, centre, distance(eye, centre)));
    if (seen === undefined) return undefined;
    this.#memory.remember(seen);
    return seen;
  }

  /**
   * Pull a recollection, counting it. Recalls go through the ledger by hand
   * rather than through `gate.sense`, because `sense` stamps the present time
   * and a recollection must keep the moment it was actually sensed — the age is
   * the whole reason memory is tagged separately from sight.
   */
  #recall(position: Vec3Like): Observed<BlockInfo> | undefined {
    const recalled = this.#memory.recall(position);
    if (recalled === undefined) return undefined;
    if (this.#gate.hasExpired(recalled.sensedAt)) {
      this.#memory.forget(position);
      return undefined;
    }
    this.#gate.ledger.record('memory');
    return recalled;
  }

  #eye(): Vec3Like {
    return this.#sensors.body().eyePosition;
  }

  #check(from: Vec3Like, to: Vec3Like, at: number): SightCheck {
    return { distance: at, occluded: this.#sensors.isOccluded(from, to) };
  }
}

function matchesKind(entity: EntityInfo, kinds: readonly string[]): boolean {
  return kinds.includes(entity.kind) || kinds.includes(entity.name);
}
