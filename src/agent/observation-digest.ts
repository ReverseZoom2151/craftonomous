import type { Vec3Like } from '../embodiment/geometry.js';
import { key as posKey } from '../embodiment/geometry.js';
import type {
  BlockInfo,
  BodyState,
  ContainerView,
  EntityInfo,
  ItemStack,
} from '../embodiment/types.js';
import type { Observed } from '../observation/observed.js';
import type { PerceptionReport } from '../perception/ledger.js';
import type { PerceptionProfile } from '../perception/profile.js';
import type { WorldView } from '../perception/world-view.js';

/**
 * Turning a `WorldView` into text an LLM can read.
 *
 * The one thing this file must never do is launder provenance. A remembered
 * block rendered as a bare fact — `iron_ore at (12,40,-3)` — reads to a model
 * exactly like something the agent can see right now. If that sighting was four
 * minutes ago the agent will walk to a hole in the ground and report success on
 * a fiction. So every line carries its tag, and remembered lines carry an age.
 *
 * The second thing it must never do is grow without bound. A prompt built from
 * an unbounded entity list is a prompt whose cost is set by the world rather
 * than by us, so every list is capped and every cap reports what it dropped.
 */

/** How stale a non-remembered observation may be before its age is shown. */
const AGE_VISIBLE_MS = 1000;

export interface DigestOptions {
  /** Maximum entity lines. Default 8. */
  readonly maxEntities?: number;
  /** Maximum block lines. Default 12. */
  readonly maxBlocks?: number;
  /** Maximum inventory stacks listed. Default 16. */
  readonly maxInventory?: number;
  /** Maximum container stacks listed. Default 12. */
  readonly maxContainer?: number;
  /** Only entities within this distance are asked for. Default: profile sight range. */
  readonly entityRadius?: number;
  /**
   * Block names worth searching for. Without these only recollections are
   * listed, because `WorldView.findBlocks` has no "everything" mode by design.
   */
  readonly blockNames?: readonly string[];
  /** Radius for the block search. Default: profile sight range. */
  readonly blockRadius?: number;
  /** Include the perception ledger tally. Default true. */
  readonly includeReport?: boolean;
}

export interface DigestElision {
  readonly entities: number;
  readonly blocks: number;
  readonly inventory: number;
  readonly container: number;
}

/**
 * The digest in both forms: rendered text for a prompt, and the structured
 * slice it was rendered from, so a deterministic policy does not have to parse
 * its own prose back out again.
 */
export interface ObservationDigest {
  readonly text: string;
  readonly at: number;
  readonly profile: PerceptionProfile;
  readonly body: Observed<BodyState>;
  readonly inventory: Observed<readonly ItemStack[]>;
  /** Capped, nearest first. */
  readonly entities: readonly Observed<EntityInfo>[];
  /** Capped. Sighted blocks first, then recollections, oldest last. */
  readonly blocks: readonly Observed<BlockInfo>[];
  readonly container: Observed<ContainerView> | undefined;
  readonly report: PerceptionReport | undefined;
  readonly elided: DigestElision;
}

/** `240000` -> `4m`. Coarse on purpose: nobody plans around 3m41s. */
export function formatAge(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return '<1s';
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)}m`;
  return `${Math.floor(clamped / 3_600_000)}h`;
}

/**
 * The provenance tag for one observation.
 *
 * Memory always shows its age; nothing else is allowed to read as present when
 * it is not. Sighted facts show an age too once they are stale enough to
 * matter, because a "current" reading from ten seconds ago is a small lie of
 * the same species.
 */
export function provenanceTag(
  observation: Observed<unknown>,
  now: number,
): string {
  const age = Math.max(0, now - observation.sensedAt);
  const stale = age >= AGE_VISIBLE_MS;
  switch (observation.provenance) {
    case 'memory':
      return `[remembered ${formatAge(age)} ago]`;
    case 'sight':
      return stale ? `[seen ${formatAge(age)} ago]` : '[seen]';
    case 'hearing':
      return stale ? `[heard ${formatAge(age)} ago]` : '[heard]';
    case 'proprioception':
      return stale ? `[felt ${formatAge(age)} ago]` : '[felt]';
    case 'inference':
      return stale ? `[inferred ${formatAge(age)} ago]` : '[inferred]';
    case 'testimony':
      return stale ? `[told ${formatAge(age)} ago]` : '[told]';
    case 'privileged':
      return stale ? `[privileged ${formatAge(age)} ago]` : '[privileged]';
  }
}

export function formatPosition(p: Vec3Like): string {
  return `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
}

function formatRange(n: number): string {
  return Number.isFinite(n) ? String(n) : 'unlimited';
}

function formatHorizon(ms: number): string {
  return Number.isFinite(ms) ? formatAge(ms) : 'unlimited';
}

function describeProfile(profile: PerceptionProfile): string {
  const parts = [
    `sight ${formatRange(profile.sightRange)}`,
    profile.requireLineOfSight
      ? 'line of sight required'
      : 'sees through walls',
    `hearing ${formatRange(profile.hearingRange)}`,
    `memory ${formatHorizon(profile.memoryHorizonMs)}`,
  ];
  if (profile.allowPrivileged) parts.push('privileged reads allowed');
  return `${profile.name}: ${parts.join(', ')}`;
}

function describeBody(body: BodyState): string {
  const flags: string[] = [];
  if (body.onGround) flags.push('on-ground');
  if (body.inWater) flags.push('in-water');
  if (body.inLava) flags.push('IN LAVA');
  if (body.isBurning) flags.push('BURNING');
  if (body.oxygen < 20) flags.push(`oxygen ${body.oxygen}/20`);
  return [
    `at ${formatPosition(body.position)} in ${body.dimension}`,
    `health ${body.health}/20`,
    `food ${body.food}/20`,
    ...flags,
  ].join(', ');
}

function describeEntity(e: EntityInfo, origin: Vec3Like): string {
  const dx = e.position.x - origin.x;
  const dy = e.position.y - origin.y;
  const dz = e.position.z - origin.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const bits = [
    `${e.name}#${e.id}`,
    `at ${formatPosition(e.position)}`,
    `${dist.toFixed(1)}m`,
  ];
  if (e.username !== undefined) bits.push(`player ${e.username}`);
  if (e.hostile === true) bits.push('HOSTILE');
  if (e.health !== undefined) bits.push(`hp ${e.health}`);
  return bits.join(' ');
}

/** Sighted before remembered, then freshest first: the useful reading order. */
function freshestFirst(
  a: Observed<unknown>,
  b: Observed<unknown>,
): number {
  const am = a.provenance === 'memory' ? 1 : 0;
  const bm = b.provenance === 'memory' ? 1 : 0;
  if (am !== bm) return am - bm;
  return b.sensedAt - a.sensedAt;
}

/**
 * Read the world once and build both the structured slice and its rendering.
 *
 * Every read goes through the injected `WorldView`, so everything this digest
 * contains has already been gated and counted. There is deliberately no path
 * here to a `SensorPort`.
 */
export function buildDigest(
  world: WorldView,
  now: number,
  options: DigestOptions = {},
): ObservationDigest {
  const maxEntities = options.maxEntities ?? 8;
  const maxBlocks = options.maxBlocks ?? 12;
  const maxInventory = options.maxInventory ?? 16;
  const maxContainer = options.maxContainer ?? 12;
  const profile = world.profile;

  const body = world.body();
  const inventory = world.inventory();

  const entityRadius = options.entityRadius ?? profile.sightRange;
  const allEntities = world.nearbyEntities(
    Number.isFinite(entityRadius) ? { maxDistance: entityRadius } : {},
  );

  const blockRadius = options.blockRadius ?? profile.sightRange;
  const found: Observed<BlockInfo>[] =
    options.blockNames && options.blockNames.length > 0
      ? [
          ...world.findBlocks({
            names: options.blockNames,
            maxDistance: Number.isFinite(blockRadius)
              ? blockRadius
              : Number.MAX_SAFE_INTEGER,
          }),
        ]
      : [];

  // Recollections are what the agent knows but cannot currently sense. They are
  // the whole reason provenance has to be visible, so they are never dropped in
  // favour of sighted blocks without being counted as elided.
  const seenKeys = new Set(found.map((o) => posKey(o.value.position)));
  const allBlocks = [
    ...found,
    ...world.recollections().filter((o) => !seenKeys.has(posKey(o.value.position))),
  ].sort(freshestFirst);

  const container = world.openContainer();
  const report = (options.includeReport ?? true) ? world.report() : undefined;

  const entities = allEntities.slice(0, Math.max(0, maxEntities));
  const blocks = allBlocks.slice(0, Math.max(0, maxBlocks));
  const stacks = inventory.value.slice(0, Math.max(0, maxInventory));
  const containerStacks = container
    ? container.value.contents.slice(0, Math.max(0, maxContainer))
    : [];

  const elided: DigestElision = {
    entities: allEntities.length - entities.length,
    blocks: allBlocks.length - blocks.length,
    inventory: inventory.value.length - stacks.length,
    container: container
      ? container.value.contents.length - containerStacks.length
      : 0,
  };

  const lines: string[] = [];

  lines.push(`== body ${provenanceTag(body, now)} ==`);
  lines.push(describeBody(body.value));

  lines.push('');
  lines.push(
    `== inventory (${stacks.length} of ${inventory.value.length} stacks) ${provenanceTag(inventory, now)} ==`,
  );
  lines.push(
    stacks.length === 0
      ? 'empty'
      : stacks.map((s) => `${s.count}x ${s.name}`).join(', '),
  );
  if (elided.inventory > 0) {
    lines.push(`… ${elided.inventory} more stacks elided`);
  }

  lines.push('');
  lines.push(
    `== nearby entities (${entities.length} of ${allEntities.length}) ==`,
  );
  if (entities.length === 0) {
    lines.push('none sensed');
  } else {
    for (const e of entities) {
      lines.push(
        `${describeEntity(e.value, body.value.position)} ${provenanceTag(e, now)}`,
      );
    }
  }
  if (elided.entities > 0) {
    lines.push(`… ${elided.entities} more entities elided`);
  }

  lines.push('');
  lines.push(`== known blocks (${blocks.length} of ${allBlocks.length}) ==`);
  if (blocks.length === 0) {
    lines.push('none known');
  } else {
    for (const b of blocks) {
      lines.push(
        `${b.value.name} at ${formatPosition(b.value.position)} ${provenanceTag(b, now)}`,
      );
    }
  }
  if (elided.blocks > 0) {
    lines.push(`… ${elided.blocks} more known blocks elided`);
  }

  if (container) {
    lines.push('');
    lines.push(
      `== open ${container.value.kind} at ${formatPosition(container.value.position)} ${provenanceTag(container, now)} ==`,
    );
    lines.push(
      containerStacks.length === 0
        ? 'empty'
        : containerStacks.map((s) => `${s.count}x ${s.name}`).join(', '),
    );
    if (elided.container > 0) {
      lines.push(`… ${elided.container} more stacks elided`);
    }
  }

  lines.push('');
  lines.push('== perception ==');
  lines.push(describeProfile(profile));
  if (report) {
    lines.push(
      `reads so far: ${report.total} (privileged ${report.privileged}, fair play ${report.fairPlay ? 'yes' : 'no'})`,
    );
  }
  lines.push(
    'Anything tagged [remembered] may no longer be true. Verify before relying on it.',
  );

  return {
    text: lines.join('\n'),
    at: now,
    profile,
    body,
    inventory,
    entities,
    blocks,
    container,
    report,
    elided,
  };
}

/** Convenience for callers that only want the prompt text. */
export function digestText(
  world: WorldView,
  now: number,
  options: DigestOptions = {},
): string {
  return buildDigest(world, now, options).text;
}
