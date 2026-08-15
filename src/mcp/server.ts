/**
 * The MCP surface: the body, exposed so that any agent can drive it.
 *
 * ## Protocol version
 *
 * Built against `@modelcontextprotocol/sdk` 1.30.0, which speaks up to
 * **2025-11-25** and negotiates down to 2024-10-07. The latest published spec
 * at time of writing is 2026-07-28, and this SDK does not implement it, so we
 * deliberately use none of its additions: no `resultType: "complete"` on list
 * results, no multi-round-trip requests or `InputRequiredResult`, no
 * `subscriptions/listen` streams, no required `_meta` protocol fields, no
 * `x-mcp-header` mirroring, no `ttlMs`/`cacheScope`. Hand-rolling those wire
 * shapes against an SDK that cannot parse them would produce a server that
 * looks current and interoperates with nothing.
 *
 * ## Statefulness
 *
 * MCP has no protocol-level session. Anything stateful (an open container,
 * for instance) must be handed back to the agent as an explicit opaque handle
 * and accepted as an argument later, never inferred from connection state.
 * The `craftonomous://surroundings` resource reports the open container as an
 * observation, not as a session the agent is inside.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ActuatorPort } from '../embodiment/port.js';
import type { PerceptionProfile } from '../perception/profile.js';
import type { WorldView } from '../perception/world-view.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ReliabilityTracker } from '../skills/reliability.js';
import type { SkillContext } from '../skills/types.js';
import type { Clock } from '../runtime/clock.js';
import { systemClock } from '../runtime/clock.js';
import type { Logger } from '../runtime/logger.js';
import { silentLogger } from '../runtime/logger.js';
import { offlineActuators } from './offline.js';
import type { RateLimitSetting } from './rate-limit.js';
import { RateLimiter } from './rate-limit.js';
import { ResourceCatalog, UnknownResource } from './resources.js';
import type { SkillContextFactory, SkillInvoker } from './tools.js';
import { ToolDispatcher } from './tools.js';

/** Server identity reported during initialization. */
export const SERVER_INFO = {
  name: 'craftonomous',
  version: '0.0.1',
} as const;

/**
 * The protocol version this server was written against. Recorded so a run
 * manifest can say what wire format produced it.
 */
export const TARGET_PROTOCOL_VERSION = '2025-11-25';

const INSTRUCTIONS = `A Minecraft body, driven over MCP.

Tools are skills. A tool call returns structured content: on success
{ ok: true, value, durationMs }, on failure { ok: false, kind, retryable,
message } with isError set. The failure kind is the useful part: 'timeout',
'unreachable' and 'world-changed' are worth retrying, 'precondition' means
re-plan, 'not-permitted' means the perception profile forbade a read the skill
needed.

Resources are the world as this body knows it. Every fact carries its
provenance: how the agent came to know it, and whether an unaided human player
could have. Absence means not known, which is not the same as not there.
Read craftonomous://perception to see the profile a run was scored under.`;

export interface CreateServerOptions {
  readonly registry: SkillRegistry;
  readonly invoker: SkillInvoker;
  readonly world: WorldView;
  readonly reliability: ReliabilityTracker;
  /** Defaults to the profile the world view is already gated by. */
  readonly profile?: PerceptionProfile;
  /**
   * Builds the context a skill runs in. Supply this when the caller owns the
   * body; otherwise one is assembled from `world` and the options below.
   */
  readonly context?: SkillContextFactory;
  /** Actuators for the assembled context. Offline refusals when omitted. */
  readonly act?: ActuatorPort;
  readonly clock?: Clock;
  readonly log?: Logger;
  /**
   * Tool call budgets. On by default with the limits documented in
   * `rate-limit.ts`; pass a partial {@link RateLimitSetting} to override either
   * budget, or the literal `'off'` to serve with none.
   *
   * Disabling has to be written down. The limits are there to stop a looping
   * agent getting the body kicked or the account throttled, and that is not a
   * protection anyone should lose by forgetting a field.
   */
  readonly rateLimit?: RateLimitSetting;
}

function contextFactory(options: CreateServerOptions): SkillContextFactory {
  if (options.context) return options.context;
  const act = options.act ?? offlineActuators;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLogger;
  return (signal: AbortSignal): SkillContext => ({
    world: options.world,
    act,
    clock,
    log,
    signal,
  });
}

/**
 * The limiter a server runs with, or `undefined` when explicitly switched off.
 *
 * The limiter shares the server's clock, so a caller replaying a run with a
 * fake clock gets the same refusals in the same places.
 */
function limiterFor(options: CreateServerOptions): RateLimiter | undefined {
  const setting = options.rateLimit ?? {};
  if (setting === 'off') return undefined;
  return new RateLimiter({
    ...setting,
    clock: setting.clock ?? options.clock ?? systemClock,
  });
}

export interface CraftonomousServer {
  readonly server: Server;
  readonly tools: ToolDispatcher;
  readonly resources: ResourceCatalog;
}

/**
 * Wire a registry, an invoker and a world view up as an MCP server.
 *
 * Note what is not a parameter: a `SensorPort`. The MCP surface sits above the
 * perception gate and can only learn about the world through the `WorldView`
 * it is given, so every fact it publishes carries provenance by construction
 * rather than by discipline.
 */
export function createServer(options: CreateServerOptions): CraftonomousServer {
  const tools = new ToolDispatcher({
    registry: options.registry,
    invoker: options.invoker,
    context: contextFactory(options),
    limiter: limiterFor(options),
  });

  const resources = new ResourceCatalog({
    world: options.world,
    registry: options.registry,
    reliability: options.reliability,
    ...(options.profile ? { profile: options.profile } : {}),
  });

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.list()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    tools.call(request.params.name, request.params.arguments, extra.signal),
  );

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [...resources.list()],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    try {
      return resources.read(request.params.uri);
    } catch (error) {
      // An unknown URI is a protocol error: the agent asked for something this
      // server does not have. A world it cannot currently sense is not a
      // protocol error; that comes back inside the resource as
      // `available: false`.
      if (error instanceof UnknownResource) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  });

  return { server, tools, resources };
}

/** Serve over stdio, the transport a local agent launches this body with. */
export async function startStdio(
  server: Server | CraftonomousServer,
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  const target = server instanceof Server ? server : server.server;
  await target.connect(transport);
  return transport;
}
