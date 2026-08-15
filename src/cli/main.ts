#!/usr/bin/env node
/**
 * Start the Craftonomous body as an MCP server over stdio.
 *
 * Everything diagnostic goes to stderr. stdout belongs to the protocol, and a
 * stray `console.log` there corrupts the JSON-RPC stream.
 */
import type { PerceptionProfile } from '../perception/profile.js';
import {
  BUILTIN_PROFILES,
  FAIR_PLAY,
  profileByName,
} from '../perception/profile.js';
import type { Session } from '../runtime/session.js';
import { SkillRegistry } from '../skills/registry.js';
import { ReliabilityTracker } from '../skills/reliability.js';
import { OfflineInvoker, OfflineWorldView } from '../mcp/offline.js';
import { createServer, startStdio } from '../mcp/server.js';

/**
 * Re-exported for compatibility: `Session` now lives in `src/runtime/session.ts`
 * beside the bootstrap that builds one, and is wider than the four members the
 * CLI itself uses.
 */
export type { Session };

export interface CliConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly version: string | undefined;
  readonly auth: 'offline' | 'microsoft';
  readonly profile: PerceptionProfile;
}

const DEFAULTS = {
  host: 'localhost',
  port: 25565,
  username: 'craftonomous',
} as const;

export class BadConfig extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadConfig';
  }
}

/** Read configuration from the environment, refusing anything nonsensical. */
export function readConfig(env: NodeJS.ProcessEnv): CliConfig {
  const rawPort = env['MINECRAFT_PORT'];
  const port = rawPort === undefined ? DEFAULTS.port : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadConfig(`MINECRAFT_PORT is not a valid port: ${rawPort}`);
  }

  const rawAuth = env['MINECRAFT_AUTH'] ?? 'offline';
  if (rawAuth !== 'offline' && rawAuth !== 'microsoft') {
    throw new BadConfig(
      `MINECRAFT_AUTH must be "offline" or "microsoft", got ${rawAuth}`,
    );
  }

  const profileName = env['CRAFTONOMOUS_PROFILE'];
  const profile =
    profileName === undefined ? FAIR_PLAY : profileByName(profileName);
  if (!profile) {
    const known = Object.values(BUILTIN_PROFILES)
      .map((p) => p.name)
      .join(', ');
    throw new BadConfig(
      `CRAFTONOMOUS_PROFILE "${profileName}" is not a known profile; known profiles are ${known}`,
    );
  }

  return {
    host: env['MINECRAFT_HOST'] ?? DEFAULTS.host,
    port,
    username: env['MINECRAFT_USERNAME'] ?? DEFAULTS.username,
    version: env['MINECRAFT_VERSION'],
    auth: rawAuth,
    profile,
  };
}

/** Where the CLI looks for a live body, unless told otherwise. */
export const DEFAULT_BOOTSTRAP = '../runtime/bootstrap.js';

interface BootstrapModule {
  createSession(config: CliConfig): Promise<Session> | Session;
}

function looksLikeBootstrap(value: unknown): value is BootstrapModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createSession?: unknown }).createSession === 'function'
  );
}

export interface LoadResult {
  readonly session: Session | undefined;
  /** Why there is no live body, when there is none. */
  readonly reason?: string;
}

/**
 * Try to load a live body. Returns the reason rather than throwing, because a
 * missing binding is an expected state, not a crash.
 */
export async function loadSession(
  config: CliConfig,
  specifier: string,
): Promise<LoadResult> {
  let mod: unknown;
  try {
    mod = (await import(specifier)) as unknown;
  } catch (error) {
    return {
      session: undefined,
      reason: `could not load the embodiment binding at "${specifier}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!looksLikeBootstrap(mod)) {
    return {
      session: undefined,
      reason: `"${specifier}" does not export a createSession(config) function`,
    };
  }
  try {
    return { session: await mod.createSession(config) };
  } catch (error) {
    return {
      session: undefined,
      reason: `createSession failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = readConfig(env);
  const specifier = env['CRAFTONOMOUS_BOOTSTRAP'] ?? DEFAULT_BOOTSTRAP;

  note(`craftonomous: MCP body over stdio`);
  note(
    `  server ${config.host}:${config.port} as "${config.username}"` +
      `${config.version ? ` (${config.version})` : ' (version auto-detected)'}` +
      `, auth ${config.auth}`,
  );
  note(`  perception profile: ${config.profile.name}`);

  const { session, reason } = await loadSession(config, specifier);

  if (session) {
    note('  mode: LIVE, a Minecraft body is bound');
    // Pass the session's real actuator and clock. The invoker substitutes its
    // own ports over whatever context it is handed, so omitting these is not
    // currently observable, but it would leave the MCP layer's default context
    // holding offline actuators that silently perform nothing. Relying on one
    // layer to paper over another's missing wiring is how a live bug waits.
    const { server } = createServer({
      registry: session.registry,
      invoker: session.invoker,
      world: session.world,
      reliability: session.reliability,
      profile: session.gate.profile,
      act: session.act,
      clock: session.clock,
    });
    await startStdio(server);
    return;
  }

  // Offline. Say exactly what is missing; do not start something that looks
  // live and answers with invented world state.
  note('  mode: OFFLINE, no Minecraft body is bound');
  note(`  reason: ${reason ?? 'no embodiment binding was found'}`);
  note('  missing: a module exporting createSession(config): Session,');
  note(
    `           resolved from CRAFTONOMOUS_BOOTSTRAP (default ${DEFAULT_BOOTSTRAP}).`,
  );
  note('  the MCP surface still starts: tools list, resources answer, and');
  note(
    '  every world read reports that it is unavailable rather than guessing.',
  );

  const { server } = createServer({
    registry: new SkillRegistry(),
    invoker: new OfflineInvoker(),
    world: new OfflineWorldView(config.profile),
    reliability: new ReliabilityTracker(),
    profile: config.profile,
  });
  await startStdio(server);
}

// Only run when executed, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url.endsWith('main.js')) {
  main().catch((error: unknown) => {
    note(
      `craftonomous failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
