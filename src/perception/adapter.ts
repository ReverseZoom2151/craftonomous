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
import type { Testimony } from './testimony.js';
import { TestimonyRegister, unverified } from './testimony.js';
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

/** The eight points a heard bearing is rounded to, clockwise from north. */
export const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

export type DistanceBand = 'underfoot' | 'close' | 'nearby' | 'distant' | 'faint';

/**
 * How loudness is turned into a range of distances rather than a number.
 *
 * The bands are coarse on purpose. A listener learns roughly how far off a
 * thing is, in the way a player learns it: near enough to matter, or not.
 */
const DISTANCE_BANDS: readonly Band[] = [
  { band: 'underfoot', min: 0, max: 4 },
  { band: 'close', min: 4, max: 8 },
  { band: 'nearby', min: 8, max: 16 },
  { band: 'distant', min: 16, max: 32 },
  { band: 'faint', min: 32, max: Number.POSITIVE_INFINITY },
];

/** Vertical separation, in blocks, within which a sound counts as level. */
const LEVEL_BAND = 2;

/**
 * A sound as a listener actually receives it: a direction, a rough distance,
 * and no coordinate.
 *
 * **There is deliberately no position on this type.** The substrate knows
 * exactly where the sound came from, and handing that through would be sight
 * wearing hearing's label: an agent could pathfind straight to an unseen
 * creeper and the ledger would call it fair play. What a listener genuinely
 * gets is a bearing, a sense of elevation, and a sense of how far, so that is
 * all this carries. `minDistance` and `maxDistance` bound the band, which lets
 * a caller reason about where the source might be without pretending to know.
 */
export interface HeardSound {
  readonly name: string;
  /** Direction from the agent to the source, rounded to eight points. */
  readonly bearing: CompassPoint;
  readonly elevation: 'above' | 'level' | 'below';
  readonly band: DistanceBand;
  /** Inclusive lower bound of the band, in blocks. */
  readonly minDistance: number;
  /** Exclusive upper bound of the band, in blocks. May be infinite. */
  readonly maxDistance: number;
  readonly volume: number;
}

/** Round a direction to one of eight compass points. */
export function bearingOf(from: Vec3Like, to: Vec3Like): CompassPoint {
  // Minecraft convention: negative Z is north, positive X is east.
  const east = to.x - from.x;
  const north = from.z - to.z;
  if (east === 0 && north === 0) return 'N';
  const degrees = (Math.atan2(east, north) * 180) / Math.PI;
  const index = Math.round(((degrees % 360) + 360) / 45) % 8;
  return COMPASS_POINTS[index] ?? 'N';
}

interface Band {
  readonly band: DistanceBand;
  readonly min: number;
  readonly max: number;
}

function bandOf(at: number): Band {
  for (const entry of DISTANCE_BANDS) {
    if (at < entry.max) return entry;
  }
  // Unreachable while the last band is unbounded, but a total function beats a
  // non-null assertion.
  return { band: 'faint', min: 32, max: Number.POSITIVE_INFINITY };
}

function elevationOf(dy: number): HeardSound['elevation'] {
  if (dy > LEVEL_BAND) return 'above';
  if (dy < -LEVEL_BAND) return 'below';
  return 'level';
}

export interface PerceptionAdapterOptions {
  /**
   * Where the currently open container comes from. Containers are opened
   * through the actuators, not the sensors, so the adapter cannot discover one
   * on its own; whoever wires the body supplies the lookup. Without it,
   * `openContainer()` always reports nothing open.
   */
  readonly containerSource?: () => ContainerView | undefined;

  /**
   * Where the record of who was seen where lives. Supplied when a caller wants
   * to inspect or reset it; otherwise the adapter keeps its own.
   */
  readonly testimonyRegister?: TestimonyRegister;

  /**
   * The sight range credited to *other* players when checking whether one of
   * them could have known what they claim. Defaults to the agent's own sight
   * range, which is a guess and is named here so it can be overridden rather
   * than silently assumed.
   */
  readonly speakerSightRange?: number;
}

/**
 * The one and only place a {@link SensorPort} is allowed to live.
 *
 * **This is the only class in the codebase permitted to hold a `SensorPort`.**
 * Everything above it (skills, planners, the MCP surface, the reference agent)
 * receives a {@link WorldView} and nothing else. That is not a style
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
  readonly #register: TestimonyRegister;
  readonly #speakerSightRange: number | undefined;

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
    this.#register = options.testimonyRegister ?? new TestimonyRegister();
    this.#speakerSightRange = options.speakerSightRange;
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

    return ranked.map(({ entity }) => {
      const seen = this.#gate.sense(entity, 'sight');
      this.#notePlayer(seen);
      return seen;
    });
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

  /**
   * Sounds heard since the last call, oldest first.
   *
   * Draining is the read: an event heard once is not heard again. A sound
   * beyond the profile's `hearingRange` is not returned and, because the gate
   * refuses it before recording, is not counted either. The ledger must show
   * what the agent learned, and it learned nothing from a sound it could not
   * hear.
   *
   * Each result carries a bearing and a distance band, never a coordinate.
   * See {@link HeardSound} for why that is not a limitation to be worked
   * around.
   *
   * Not on {@link WorldView}: that interface predates hearing having a
   * producer, and this adapter does not own it.
   */
  sounds(): readonly Observed<HeardSound>[] {
    const drained = this.#sensors.drainSounds?.() ?? [];
    if (drained.length === 0) return [];

    const eye = this.#eye();
    const out: Observed<HeardSound>[] = [];
    for (const event of drained) {
      const source = event.approximatePosition;
      const at = distance(eye, source);
      const band = bandOf(at);
      const heard: HeardSound = {
        name: event.name,
        bearing: bearingOf(eye, source),
        elevation: elevationOf(source.y - eye.y),
        band: band.band,
        minDistance: band.min,
        maxDistance: band.max,
        volume: event.volume,
      };
      const observed = this.#gate.sound(heard, at);
      if (observed !== undefined) out.push(observed);
    }
    return out;
  }

  /**
   * Chat received since the last call, as testimony, oldest first.
   *
   * Every message is admitted: hearing somebody speak is not the same as
   * believing them, and a claim the agent refused to receive cannot be weighed
   * later. What arrives is tagged `testimony` and marked unverified, and it
   * stays `testimony` however well it later checks out.
   *
   * Not on {@link WorldView}, for the same reason as {@link sounds}.
   */
  testimony(): readonly Observed<Testimony>[] {
    const drained = this.#sensors.drainChat?.() ?? [];
    return drained.map((message) => this.#gate.sense(unverified(message), 'testimony'));
  }

  /**
   * Ask whether a speaker could plausibly have known what they claim about a
   * position, given where this agent has seen them.
   *
   * The answer is returned as a new {@link Testimony} with a status and a
   * reason. It is never an upgrade: the provenance of the observation carrying
   * the claim is untouched, and no status this returns makes a claim true. See
   * {@link TestimonyRegister} for what the check can and cannot establish.
   */
  checkPositionClaim(claim: Testimony, position: Vec3Like): Testimony {
    const range = this.#speakerSightRange ?? this.#gate.profile.sightRange;
    return this.#register.checkPositionClaim(claim, position, range);
  }

  /** Where this agent has seen each speaker. Read-only; feeding it is the adapter's job. */
  speakerRegister(): TestimonyRegister {
    return this.#register;
  }

  /** How this agent has come by its knowledge so far. */
  report(): PerceptionReport {
    return this.#gate.ledger.report();
  }

  /**
   * Remember where a sighted player was, for later credibility checks. Only
   * gated sightings reach here, so the register can never become a way around
   * the profile.
   */
  #notePlayer(seen: Observed<EntityInfo>): void {
    const username = seen.value.username;
    if (username === undefined) return;
    this.#register.noteSeen(username, seen.value.position, seen.sensedAt);
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
   * and a recollection must keep the moment it was actually sensed. The age is
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
