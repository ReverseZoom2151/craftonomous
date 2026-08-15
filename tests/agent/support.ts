import type { Vec3Like } from '../../src/embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../../src/embodiment/types.js';
import type { Observed } from '../../src/observation/observed.js';
import type { Provenance } from '../../src/observation/provenance.js';
import { PerceptionLedger } from '../../src/perception/ledger.js';
import type { PerceptionReport } from '../../src/perception/ledger.js';
import { FAIR_PLAY } from '../../src/perception/profile.js';
import type { PerceptionProfile } from '../../src/perception/profile.js';
import type { WorldView } from '../../src/perception/world-view.js';
import type {
  InvocationResult,
  SkillInvoker,
} from '../../src/agent/policy.js';

/**
 * A hand-built WorldView. The agent under test cannot tell this from a real
 * one, which is the point: nothing above the perception gate is allowed to
 * reach past it, so a fake gate is a complete substitute.
 */
export class FakeWorld implements WorldView {
  profile: PerceptionProfile = FAIR_PLAY;
  bodyState: BodyState = defaultBody();
  items: ItemStack[] = [];
  entities: Observed<EntityInfo>[] = [];
  blocks: Observed<BlockInfo>[] = [];
  remembered: Observed<BlockInfo>[] = [];
  container: Observed<ContainerView> | undefined;
  readonly ledger = new PerceptionLedger();

  constructor(private readonly clock: { now(): number }) {}

  body(): Observed<BodyState> {
    this.ledger.record('proprioception');
    return obs(this.bodyState, 'proprioception', this.clock.now());
  }

  inventory(): Observed<readonly ItemStack[]> {
    this.ledger.record('proprioception');
    return obs(this.items, 'proprioception', this.clock.now());
  }

  blockAt(position: Vec3Like): Observed<BlockInfo> | undefined {
    return [...this.blocks, ...this.remembered].find(
      (b) =>
        b.value.position.x === position.x &&
        b.value.position.y === position.y &&
        b.value.position.z === position.z,
    );
  }

  nearbyEntities(): readonly Observed<EntityInfo>[] {
    this.ledger.record('sight', this.entities.length);
    return this.entities;
  }

  findBlocks(options: {
    readonly names: readonly string[];
    readonly maxDistance: number;
    readonly limit?: number;
  }): readonly Observed<BlockInfo>[] {
    const hits = this.blocks.filter((b) =>
      options.names.includes(b.value.name),
    );
    this.ledger.record('sight', hits.length);
    return options.limit === undefined ? hits : hits.slice(0, options.limit);
  }

  openContainer(): Observed<ContainerView> | undefined {
    return this.container;
  }

  recollections(): readonly Observed<BlockInfo>[] {
    this.ledger.record('memory', this.remembered.length);
    return this.remembered;
  }

  report(): PerceptionReport {
    return this.ledger.report();
  }
}

export function obs<T>(
  value: T,
  provenance: Provenance,
  sensedAt: number,
): Observed<T> {
  return { value, provenance, sensedAt };
}

export function defaultBody(overrides: Partial<BodyState> = {}): BodyState {
  return {
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
    ...overrides,
  };
}

export function block(
  name: string,
  position: Vec3Like,
  overrides: Partial<BlockInfo> = {},
): BlockInfo {
  return { name, position, solid: true, ...overrides };
}

export function entity(
  id: number,
  name: string,
  position: Vec3Like,
  overrides: Partial<EntityInfo> = {},
): EntityInfo {
  return { id, name, kind: 'mob', position, ...overrides };
}

export interface RecordedCall {
  readonly name: string;
  readonly input: unknown;
}

/** An invoker that records calls and replies from a canned table. */
export class FakeInvoker implements SkillInvoker {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly replies: Record<
      string,
      InvocationResult | (() => InvocationResult)
    > = {},
    private readonly fallback: InvocationResult = {
      ok: true,
      value: null,
      durationMs: 1,
    },
  ) {}

  invoke(name: string, input: unknown): Promise<InvocationResult> {
    this.calls.push({ name, input });
    const reply = this.replies[name];
    if (reply === undefined) return Promise.resolve(this.fallback);
    return Promise.resolve(typeof reply === 'function' ? reply() : reply);
  }
}
