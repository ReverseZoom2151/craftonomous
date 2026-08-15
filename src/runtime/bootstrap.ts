import type { CliConfig } from '../cli/main.js';
import type { FakeEmbodiment } from '../embodiment/fake/index.js';
import { FakeWorld, createFakeEmbodiment } from '../embodiment/fake/index.js';
import type { Vec3Like } from '../embodiment/geometry.js';
import type {
  ActuationOutcome,
  ActuatorPort,
  EmbodimentPort,
} from '../embodiment/port.js';
import type { ContainerView } from '../embodiment/types.js';
import type { SkillInvoker } from '../mcp/tools.js';
import { PerceptionAdapter } from '../perception/adapter.js';
import { PerceptionGate } from '../perception/gate.js';
import { WorldMemory } from '../perception/memory.js';
import type { PerceptionProfile } from '../perception/profile.js';
import { BUILTIN_PROFILES, profileByName } from '../perception/profile.js';
import type { WorldView } from '../perception/world-view.js';
import { CORE_SKILLS } from '../skills/library/index.js';
import { ReflexArbiter } from '../skills/reflex/arbiter.js';
import { builtinReflexes } from '../skills/reflex/builtin.js';
import type { Reflex } from '../skills/reflex/types.js';
import { SkillRegistry } from '../skills/registry.js';
import { ReliabilityTracker } from '../skills/reliability.js';
import { SkillRunner } from '../skills/runner.js';
import type { SkillContext, SkillResult } from '../skills/types.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { Session } from './session.js';
import { DEFAULT_REFLEX_INTERVAL_MS, ReflexSupervisor } from './supervisor.js';

/**
 * The assembly layer.
 *
 * Every other module in this repository is a piece built and tested on its own
 * against a shared contract. This is the one file that puts them together:
 * sensors behind a gate, a gate under an adapter, skills over a runner, and a
 * reflex loop over the top with the authority to interrupt any of it. Nothing
 * below constructs anything it did not have to.
 *
 * The live body is loaded by dynamic import, so this module typechecks, lints
 * and tests with no mineflayer installed and no server running. Every offline
 * path here is the same assembly over the in-memory fake, which is what makes
 * the wiring testable at all.
 */

/** How many remembered blocks a session keeps before evicting the oldest. */
export const DEFAULT_MEMORY_ENTRIES = 8192;

/** Raised when a config names a perception profile that does not exist. */
export class UnknownProfile extends Error {
  constructor(readonly requested: string) {
    const known = Object.values(BUILTIN_PROFILES)
      .map((p) => p.name)
      .join(', ');
    super(
      `"${requested}" is not a known perception profile; known profiles are ${known}`,
    );
    this.name = 'UnknownProfile';
  }
}

export interface AssembleOptions {
  /** Time source for the whole stack. Defaults to the system clock. */
  readonly clock?: Clock;
  readonly log?: Logger;
  /** Reflexes to arbitrate. Defaults to the built-in set. */
  readonly reflexes?: readonly Reflex[];
  /** How often the arbiter is evaluated. */
  readonly reflexIntervalMs?: number;
  /** Start the reflex loop immediately. On by default. */
  readonly autoStart?: boolean;
  readonly memoryEntries?: number;
}

/** A session over the in-memory fake, with the parts a test wants to poke at. */
export interface OfflineSession extends Session {
  readonly reflexes: ReflexSupervisor;
  /** The fake body behind this session. */
  readonly body: FakeEmbodiment;
}

export interface OfflineSessionOptions extends AssembleOptions {
  readonly profile?: PerceptionProfile;
  /** An already-populated world. A fresh empty one by default. */
  readonly world?: FakeWorld;
}

/**
 * Keeps the last container opened through the actuators.
 *
 * A container is opened by acting, not by sensing, so the perception adapter
 * cannot discover one on its own: whoever does the wiring has to tell it. This
 * wrapper is that telling. It delegates everything untouched and remembers only
 * what `openContainer` handed back, until `closeContainer` takes it away.
 *
 * The remembered view is a snapshot of the moment it was opened. It is not
 * refreshed after a withdraw or a deposit, because nothing in the sensor
 * contract can re-read a container, and inventing the new contents would put a
 * fabrication where a measurement belongs.
 */
class ContainerTrackingActuators implements ActuatorPort {
  #open: ContainerView | undefined;

  constructor(private readonly inner: ActuatorPort) {}

  /** The container currently open, for the adapter's `containerSource`. */
  current = (): ContainerView | undefined => this.#open;

  async openContainer(position: Vec3Like): Promise<ContainerView | undefined> {
    const view = await this.inner.openContainer(position);
    if (view !== undefined) this.#open = view;
    return view;
  }

  async closeContainer(): Promise<void> {
    this.#open = undefined;
    await this.inner.closeContainer();
  }

  moveTo(
    position: Vec3Like,
    options?: { readonly range?: number; readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    return this.inner.moveTo(position, options);
  }

  lookAt(position: Vec3Like): Promise<ActuationOutcome> {
    return this.inner.lookAt(position);
  }

  dig(
    position: Vec3Like,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ActuationOutcome> {
    return this.inner.dig(position, options);
  }

  placeBlock(
    against: Vec3Like,
    face: Vec3Like,
    item: string,
  ): Promise<ActuationOutcome> {
    return this.inner.placeBlock(against, face, item);
  }

  equip(item: string, destination?: string): Promise<ActuationOutcome> {
    return this.inner.equip(item, destination);
  }

  consume(item: string): Promise<ActuationOutcome> {
    return this.inner.consume(item);
  }

  attack(entityId: number): Promise<ActuationOutcome> {
    return this.inner.attack(entityId);
  }

  dropItem(item: string, count?: number): Promise<ActuationOutcome> {
    return this.inner.dropItem(item, count);
  }

  craft(
    recipe: string,
    count: number,
    options?: { readonly craftingTable?: Vec3Like },
  ): Promise<ActuationOutcome> {
    return this.inner.craft(recipe, count, options);
  }

  withdraw(item: string, count: number): Promise<ActuationOutcome> {
    return this.inner.withdraw(item, count);
  }

  deposit(item: string, count: number): Promise<ActuationOutcome> {
    return this.inner.deposit(item, count);
  }

  chat(message: string): Promise<ActuationOutcome> {
    return this.inner.chat(message);
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }
}

/**
 * The session's invoker: a {@link SkillRunner} with every run placed under the
 * reflex supervisor.
 *
 * The caller's context is not trusted for `world` and `act`. A caller cannot
 * know this session's ports (the MCP layer, for one, builds a context with
 * refusing offline actuators because it is given no others), and a run against
 * a world nobody wired is worse than no run at all.
 */
class SupervisedInvoker implements SkillInvoker {
  constructor(
    private readonly runner: SkillRunner,
    private readonly world: WorldView,
    private readonly act: ActuatorPort,
    private readonly supervisor: ReflexSupervisor,
    private readonly log: Logger,
  ) {}

  async run(
    name: string,
    input: unknown,
    ctx: SkillContext,
  ): Promise<SkillResult<unknown>> {
    const controller = new AbortController();
    const release = this.supervisor.guard(controller);
    // A caller's own cancellation still counts; the reflex token is folded in
    // beside it rather than replacing it.
    const outer: AbortSignal | undefined = ctx.signal;
    const signal =
      outer === undefined
        ? controller.signal
        : AbortSignal.any([outer, controller.signal]);
    try {
      return await this.runner.run(name, input, {
        world: this.world,
        act: this.act,
        log: ctx.log ?? this.log,
        signal,
      });
    } finally {
      release();
    }
  }
}

/** Everything a session is made of, over whichever body it was handed. */
function assemble(
  embodiment: EmbodimentPort,
  profile: PerceptionProfile,
  options: AssembleOptions,
): { readonly session: Session; readonly supervisor: ReflexSupervisor } {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLogger;

  // The gate is the only thing that ever sees the sensor port, and the adapter
  // is the only thing that holds one. Nothing returned below exposes either.
  const gate = new PerceptionGate(profile, clock);
  const memory = new WorldMemory(clock, {
    maxEntries: options.memoryEntries ?? DEFAULT_MEMORY_ENTRIES,
    expiry: gate,
  });
  const act = new ContainerTrackingActuators(embodiment.actuators);
  const world = new PerceptionAdapter(embodiment.sensors, gate, memory, {
    containerSource: act.current,
  });

  const registry = new SkillRegistry().registerAll(CORE_SKILLS);
  const reliability = new ReliabilityTracker();
  const runner = new SkillRunner(registry, reliability, clock, log);

  const arbiter = new ReflexArbiter(options.reflexes ?? builtinReflexes());
  const supervisor = new ReflexSupervisor({
    world,
    arbiter,
    act,
    clock,
    log,
  });
  if (options.autoStart !== false) {
    supervisor.start(options.reflexIntervalMs ?? DEFAULT_REFLEX_INTERVAL_MS);
  }

  const invoker = new SupervisedInvoker(runner, world, act, supervisor, log);

  const session: Session = {
    registry,
    invoker,
    world,
    reliability,
    act,
    gate,
    clock,
    reflexes: supervisor,
    close: async (): Promise<void> => {
      supervisor.stop();
      await supervisor.settle();
      await embodiment.disconnect();
    },
  };

  return { session, supervisor };
}

/**
 * Bind a live Minecraft body and assemble a session over it.
 *
 * This is the function `src/cli/main.ts` resolves by specifier. It is the only
 * place in `src/` that reaches for mineflayer, and it does so by dynamic import
 * so that a machine without the optional native pieces installed still
 * typechecks, lints and tests this file.
 */
export async function createSession(
  config: CliConfig,
  options: AssembleOptions = {},
): Promise<Session> {
  const profile = profileByName(config.profile.name);
  if (profile === undefined) throw new UnknownProfile(config.profile.name);

  const log = options.log ?? silentLogger;
  const { connect } = await import('../embodiment/mineflayer/index.js');
  const embodiment = await connect({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    ...(config.version === undefined ? {} : { version: config.version }),
    logger: log,
  });

  return assemble(embodiment, profile, options).session;
}

/**
 * The same assembly over the in-memory fake body.
 *
 * This is what makes the wiring testable: no server, no mineflayer, no network,
 * and a world a caller put there block by block. It is also a genuinely useful
 * way to drive the MCP surface, because every tool call really runs, really
 * moves a body, and really shows up in the perception ledger.
 */
export function createOfflineSession(
  options: OfflineSessionOptions = {},
): OfflineSession {
  const profile = options.profile ?? BUILTIN_PROFILES.FAIR_PLAY;
  const body = createFakeEmbodiment(options.world ?? new FakeWorld());
  const { session, supervisor } = assemble(body, profile, options);
  return { ...session, reflexes: supervisor, body };
}
