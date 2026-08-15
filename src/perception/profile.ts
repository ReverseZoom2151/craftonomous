/**
 * A declaration of what an agent is allowed to sense.
 *
 * A profile is part of a run's identity. Two agents evaluated under different
 * profiles have not been compared, and Craftonomous reports the profile
 * alongside every result so that the difference is impossible to overlook.
 */
export interface PerceptionProfile {
  /** Human-readable name, recorded in run manifests. */
  readonly name: string;

  /** Furthest distance, in blocks, at which a block or entity can be seen. */
  readonly sightRange: number;

  /**
   * When true, a block or entity must have an unobstructed line to the agent's
   * eyes to be sighted. This is the single setting that stops an agent from
   * reading ore through stone.
   */
  readonly requireLineOfSight: boolean;

  /** Furthest distance, in blocks, at which a sound event registers. */
  readonly hearingRange: number;

  /**
   * How long a sighted fact stays in memory before it is dropped, in
   * milliseconds. Recalled facts are always tagged stale with their age;
   * this governs when they are forgotten outright.
   */
  readonly memoryHorizonMs: number;

  /**
   * Whether the agent may make reads no player could make. When false, a
   * privileged read throws instead of returning a value.
   */
  readonly allowPrivileged: boolean;
}

/**
 * The default. Approximates what a human player can know: limited sight with
 * occlusion, limited hearing, and a memory that fades.
 */
export const FAIR_PLAY: PerceptionProfile = {
  name: 'fair-play',
  sightRange: 64,
  requireLineOfSight: true,
  hearingRange: 16,
  memoryHorizonMs: 10 * 60 * 1000,
  allowPrivileged: false,
};

/**
 * Sight through walls at the same range. Useful for isolating planning ability
 * from exploration ability, which are otherwise entangled in every result.
 */
export const XRAY: PerceptionProfile = {
  name: 'xray',
  sightRange: 64,
  requireLineOfSight: false,
  hearingRange: 16,
  memoryHorizonMs: 10 * 60 * 1000,
  allowPrivileged: false,
};

/**
 * No restriction at all. This is what most prior agents run under without
 * saying so. Named here so that choosing it is a visible decision.
 */
export const OMNISCIENT: PerceptionProfile = {
  name: 'omniscient',
  sightRange: Number.POSITIVE_INFINITY,
  requireLineOfSight: false,
  hearingRange: Number.POSITIVE_INFINITY,
  memoryHorizonMs: Number.POSITIVE_INFINITY,
  allowPrivileged: true,
};

export const BUILTIN_PROFILES = { FAIR_PLAY, XRAY, OMNISCIENT } as const;

export function profileByName(name: string): PerceptionProfile | undefined {
  return Object.values(BUILTIN_PROFILES).find((p) => p.name === name);
}
