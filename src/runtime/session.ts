import type { ActuatorPort } from '../embodiment/port.js';
import type { SkillInvoker } from '../mcp/tools.js';
import type { PerceptionGate } from '../perception/gate.js';
import type { WorldView } from '../perception/world-view.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ReliabilityTracker } from '../skills/reliability.js';
import type { Clock } from './clock.js';
import type { SaveOutcome } from './persistence.js';
import type { ReflexSupervisor } from './supervisor.js';

/**
 * An assembled body: everything a caller needs to act, to read the world, and
 * to say how it came by what it knows.
 *
 * This is the contract a bootstrap module fulfils. `src/cli/main.ts` loads one
 * by specifier at runtime rather than importing it, which is what keeps the MCP
 * surface compiling and testable with no mineflayer in the picture, and is the
 * same reason the CLI can honestly report an offline start instead of failing
 * to load.
 *
 * Note what is absent: there is no `SensorPort` here and there never will be.
 * Everything a session hands out reads the world through {@link WorldView},
 * which is gated and counted. The bootstrap that assembles a session touches a
 * port because it is doing the wiring; nothing it returns exposes one.
 */
export interface Session {
  readonly registry: SkillRegistry;
  /** Runs skills. Pre-emption and reliability accounting happen behind this. */
  readonly invoker: SkillInvoker;
  readonly world: WorldView;
  readonly reliability: ReliabilityTracker;
  /** What the body can do. Actuation is not gated; only perception is. */
  readonly act: ActuatorPort;
  /**
   * The gate every observation passed through, so a caller can read the ledger
   * and the active profile without a second source of truth for either.
   */
  readonly gate: PerceptionGate;
  /** The one time source the whole stack shares. */
  readonly clock: Clock;
  /**
   * The reflex loop, when this session runs one. Optional because a third-party
   * bootstrap is free to assemble a body without reflexes, and a required
   * member would make that impossible to express.
   */
  readonly reflexes?: ReflexSupervisor;
  /**
   * Write a snapshot now, without ending the session.
   *
   * Present only when the session was assembled with a snapshot store, so its
   * absence is the honest answer to "can this session checkpoint" rather than
   * a call that silently does nothing. It resolves to an outcome rather than
   * rejecting: a checkpoint that could not be written is worth reporting, and
   * is never worth ending a healthy run over.
   */
  save?(): Promise<SaveOutcome>;
  close?(): Promise<void>;
}
