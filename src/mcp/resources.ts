import type {
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { Observed } from '../observation/observed.js';
import type { Provenance } from '../observation/provenance.js';
import { isFairPlay } from '../observation/provenance.js';
import type { PerceptionProfile } from '../perception/profile.js';
import type { WorldView } from '../perception/world-view.js';
import type { SkillRegistry } from '../skills/registry.js';
import type {
  ReliabilityStats,
  ReliabilityTracker,
} from '../skills/reliability.js';

export const RESOURCE_URIS = {
  body: 'craftonomous://body',
  inventory: 'craftonomous://inventory',
  surroundings: 'craftonomous://surroundings',
  perception: 'craftonomous://perception',
  skills: 'craftonomous://skills',
} as const;

export type ResourceUri = (typeof RESOURCE_URIS)[keyof typeof RESOURCE_URIS];

const MIME_TYPE = 'application/json';

/**
 * An observed value as it crosses the MCP boundary.
 *
 * Provenance travels with the value, always. A resource that handed an agent a
 * bare block name would be telling it *what* without telling it *how it knows*,
 * and every downstream claim about fair play would then rest on an assumption
 * nobody recorded.
 */
export interface ObservedJson<T> {
  readonly value: T;
  readonly provenance: Provenance;
  readonly sensedAt: number;
  /** Whether an unaided human player could have come by this. */
  readonly fairPlay: boolean;
}

export function observedJson<T>(observation: Observed<T>): ObservedJson<T> {
  return {
    value: observation.value,
    provenance: observation.provenance,
    sensedAt: observation.sensedAt,
    fairPlay: isFairPlay(observation.provenance),
  };
}

/** What a resource says when the body cannot answer at all. */
export interface UnavailableJson {
  readonly available: false;
  readonly reason: string;
}

/**
 * Run a read that may fail because nothing is bound behind it.
 *
 * Offline, there is no body to ask. Saying so is better than inventing a
 * position at the origin with full health, which is what a default-valued
 * fallback would amount to.
 */
function attempt<T>(read: () => T): T | UnavailableJson {
  try {
    return read();
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ResourceDeps {
  readonly world: WorldView;
  readonly registry: SkillRegistry;
  readonly reliability: ReliabilityTracker;
  /** Defaults to the profile the world view is gated by. */
  readonly profile?: PerceptionProfile;
}

function profileOf(deps: ResourceDeps): PerceptionProfile {
  return deps.profile ?? deps.world.profile;
}

/** The static resource list advertised over MCP. */
export function listResources(): readonly Resource[] {
  return [
    {
      uri: RESOURCE_URIS.body,
      name: 'body',
      title: 'Body',
      description:
        'Proprioception: position, health, food, oxygen and orientation, with provenance.',
      mimeType: MIME_TYPE,
    },
    {
      uri: RESOURCE_URIS.inventory,
      name: 'inventory',
      title: 'Inventory',
      description: 'What the agent is carrying, with provenance.',
      mimeType: MIME_TYPE,
    },
    {
      uri: RESOURCE_URIS.surroundings,
      name: 'surroundings',
      title: 'Surroundings',
      description:
        'Nearby entities and known blocks, each tagged with how it came to be known.',
      mimeType: MIME_TYPE,
    },
    {
      uri: RESOURCE_URIS.perception,
      name: 'perception',
      title: 'Perception report',
      description:
        'The active profile and the ledger: reads by provenance, privileged share, fair-play verdict.',
      mimeType: MIME_TYPE,
    },
    {
      uri: RESOURCE_URIS.skills,
      name: 'skills',
      title: 'Skills',
      description:
        'Registered skills with measured reliability, so an agent can tell a skill from a promise.',
      mimeType: MIME_TYPE,
    },
  ];
}

export function bodyResource(deps: ResourceDeps): Record<string, unknown> {
  return {
    profile: profileOf(deps).name,
    body: attempt(() => observedJson(deps.world.body())),
  };
}

export function inventoryResource(deps: ResourceDeps): Record<string, unknown> {
  const observed = attempt(() => observedJson(deps.world.inventory()));
  return {
    profile: profileOf(deps).name,
    inventory: observed,
    ...('available' in observed
      ? {}
      : { totalItems: observed.value.reduce((n, s) => n + s.count, 0) }),
  };
}

/** Options governing how much of the world the surroundings resource reports. */
export interface SurroundingsOptions {
  /** Cap on entities reported. */
  readonly maxEntities?: number;
  /** Cap on remembered blocks reported. */
  readonly maxBlocks?: number;
}

export function surroundingsResource(
  deps: ResourceDeps,
  options: SurroundingsOptions = {},
): Record<string, unknown> {
  const maxEntities = options.maxEntities ?? 64;
  const maxBlocks = options.maxBlocks ?? 128;
  const profile = profileOf(deps);

  const entities = attempt(() =>
    deps.world
      .nearbyEntities()
      .slice(0, maxEntities)
      .map((e) => observedJson(e)),
  );
  const blocks = attempt(() =>
    deps.world
      .recollections()
      .slice(0, maxBlocks)
      .map((b) => observedJson(b)),
  );
  const container = attempt(() => {
    const open = deps.world.openContainer();
    return open ? observedJson(open) : null;
  });

  return {
    profile: profile.name,
    sightRange: profile.sightRange,
    requireLineOfSight: profile.requireLineOfSight,
    // Named so an agent cannot mistake this for "the blocks that are there".
    // Absence here means not known, not not-present.
    entities,
    knownBlocks: blocks,
    openContainer: container,
  };
}

export function perceptionResource(
  deps: ResourceDeps,
): Record<string, unknown> {
  const profile = profileOf(deps);
  const report = deps.world.report();
  return {
    profile: {
      name: profile.name,
      sightRange: profile.sightRange,
      requireLineOfSight: profile.requireLineOfSight,
      hearingRange: profile.hearingRange,
      memoryHorizonMs: profile.memoryHorizonMs,
      allowPrivileged: profile.allowPrivileged,
    },
    counts: report.counts,
    total: report.total,
    privileged: report.privileged,
    privilegedShare: report.privilegedShare,
    fairPlay: report.fairPlay,
  };
}

export interface SkillResourceEntry {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly timeoutMs?: number;
  readonly reliability: ReliabilityStats;
  readonly retired: boolean;
}

export function skillsResource(deps: ResourceDeps): Record<string, unknown> {
  const skills: SkillResourceEntry[] = deps.registry.list().map((skill) => ({
    name: skill.name,
    summary: skill.summary,
    description: skill.description,
    ...(skill.timeoutMs === undefined ? {} : { timeoutMs: skill.timeoutMs }),
    reliability: deps.reliability.stats(skill.name),
    retired: deps.reliability.isRetired(skill.name),
  }));
  return {
    profile: profileOf(deps).name,
    count: skills.length,
    skills,
  };
}

/** Build the JSON body of a resource, or undefined when the URI is unknown. */
export function resourceBody(
  uri: string,
  deps: ResourceDeps,
): Record<string, unknown> | undefined {
  switch (uri) {
    case RESOURCE_URIS.body:
      return bodyResource(deps);
    case RESOURCE_URIS.inventory:
      return inventoryResource(deps);
    case RESOURCE_URIS.surroundings:
      return surroundingsResource(deps);
    case RESOURCE_URIS.perception:
      return perceptionResource(deps);
    case RESOURCE_URIS.skills:
      return skillsResource(deps);
    default:
      return undefined;
  }
}

export class UnknownResource extends Error {
  constructor(readonly uri: string) {
    super(
      `no resource at "${uri}"; known resources are ${Object.values(RESOURCE_URIS).join(', ')}`,
    );
    this.name = 'UnknownResource';
  }
}

/** Serves the read-only view of the body over MCP. */
export class ResourceCatalog {
  constructor(private readonly deps: ResourceDeps) {}

  list(): readonly Resource[] {
    return listResources();
  }

  read(uri: string): ReadResourceResult {
    const body = resourceBody(uri, this.deps);
    if (!body) throw new UnknownResource(uri);
    return {
      contents: [
        {
          uri,
          mimeType: MIME_TYPE,
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  }
}
