import type { Vec3Like } from '../embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../embodiment/types.js';
import type { ActuationOutcome, ActuatorPort } from '../embodiment/port.js';
import type { Observed } from '../observation/observed.js';
import { PROVENANCE } from '../observation/provenance.js';
import type { Provenance } from '../observation/provenance.js';
import type { PerceptionReport } from '../perception/ledger.js';
import type { PerceptionProfile } from '../perception/profile.js';
import { FAIR_PLAY } from '../perception/profile.js';
import type { WorldView } from '../perception/world-view.js';
import type { HeardSound } from '../perception/adapter.js';
import type { Testimony } from '../perception/testimony.js';
import type { SkillContext, SkillResult } from '../skills/types.js';
import { fail } from '../skills/types.js';
import type { SkillInvoker } from './tools.js';

export class NoBodyBound extends Error {
  constructor(what: string) {
    super(
      `${what} is unavailable: no Minecraft body is bound. ` +
        'Start the server with a live embodiment to read the world.',
    );
    this.name = 'NoBodyBound';
  }
}

/**
 * A world view with nothing behind it.
 *
 * Used when the server starts without a connected body. Every read either says
 * *not known* (exactly what an empty `WorldView` result means) or
 * throws {@link NoBodyBound} for the two facts that cannot honestly be absent,
 * the body and the inventory. The alternative, returning a body at the origin
 * with full health, would put a fabrication where a measurement belongs, and
 * an agent reading it could not tell the difference.
 */
export class OfflineWorldView implements WorldView {
  constructor(readonly profile: PerceptionProfile = FAIR_PLAY) {}

  body(): Observed<BodyState> {
    throw new NoBodyBound('proprioception');
  }

  inventory(): Observed<readonly ItemStack[]> {
    throw new NoBodyBound('inventory');
  }

  blockAt(_position: Vec3Like): Observed<BlockInfo> | undefined {
    return undefined;
  }

  nearbyEntities(): readonly Observed<EntityInfo>[] {
    return [];
  }

  findBlocks(): readonly Observed<BlockInfo>[] {
    return [];
  }

  openContainer(): Observed<ContainerView> | undefined {
    return undefined;
  }

  recollections(): readonly Observed<BlockInfo>[] {
    return [];
  }

  /** No body, so nothing was heard. Silence is the honest answer here. */
  sounds(): readonly Observed<HeardSound>[] {
    return [];
  }

  /** No body, so nobody spoke to it. */
  testimony(): readonly Observed<Testimony>[] {
    return [];
  }

  /**
   * Returned unchanged. With no sightings of anyone, there is no evidence
   * either way, and inventing a verdict would be worse than declining to give
   * one.
   */
  checkPositionClaim(claim: Testimony, _position: Vec3Like): Testimony {
    return claim;
  }

  /** A true report: nothing was read, because there was nothing to read. */
  report(): PerceptionReport {
    const counts = Object.fromEntries(
      PROVENANCE.map((p) => [p, 0]),
    ) as Record<Provenance, number>;
    return {
      counts,
      total: 0,
      privileged: 0,
      privilegedShare: 0,
      fairPlay: true,
    };
  }
}

const REFUSED: ActuationOutcome = {
  ok: false,
  detail: 'no Minecraft body is bound; the server is running offline',
};

const refuse = async (): Promise<ActuationOutcome> => REFUSED;

/**
 * Actuators with nothing on the other end. Every action reports that it did
 * not happen, rather than resolving as though it had.
 */
export const offlineActuators: ActuatorPort = {
  moveTo: refuse,
  lookAt: refuse,
  dig: refuse,
  placeBlock: refuse,
  equip: refuse,
  consume: refuse,
  attack: refuse,
  dropItem: refuse,
  craft: refuse,
  openContainer: async () => undefined,
  closeContainer: async () => {},
  withdraw: refuse,
  deposit: refuse,
  chat: refuse,
  stop: async () => {},
};

/**
 * An invoker that refuses every skill, naming why.
 *
 * `precondition` is the honest kind here: the precondition every skill shares
 * is having a body, and it does not hold. It is not retryable, because
 * retrying will not connect anything.
 */
export class OfflineInvoker implements SkillInvoker {
  async run(
    name: string,
    _input: unknown,
    _ctx: SkillContext,
  ): Promise<SkillResult<unknown>> {
    return fail(
      'precondition',
      `cannot run "${name}": the server is running offline with no Minecraft body bound`,
      0,
    );
  }
}
