/**
 * How a piece of world knowledge reached the agent.
 *
 * Every observation Craftonomous hands to an agent is tagged with one of these.
 * The tag is the whole point: agents in prior work read world state straight out
 * of the game client, so a result table cannot distinguish an agent that scouted
 * a cave from one that read the chunk data through a wall. Tagging provenance
 * does not forbid the second agent. It makes it countable.
 *
 * @see docs/PERCEPTION.md for how these map onto a perception profile.
 */
export const PROVENANCE = [
  /** The agent's own body: position, health, hunger, held item, inventory. */
  'proprioception',
  /** Currently within the agent's sensory range and not occluded. */
  'sight',
  /** Currently audible: an unsighted sound event with a bearing but no exact source. */
  'hearing',
  /** Previously sensed, now recalled. May be stale; the world can have moved on. */
  'memory',
  /** Derived from other observations by rule, e.g. a recipe's inputs from its output. */
  'inference',
  /** Told to the agent by another agent or a human, over in-game chat. */
  'testimony',
  /**
   * Read directly from the game state in a way no player could achieve.
   * Permitted, but always counted and always reported. An agent that leans on
   * privileged reads is not wrong, it is simply playing a different game, and
   * its results should be read next to that number.
   */
  'privileged',
] as const;

export type Provenance = (typeof PROVENANCE)[number];

/** Provenance kinds a human player could plausibly achieve unaided. */
export const FAIR_PLAY_PROVENANCE: readonly Provenance[] = [
  'proprioception',
  'sight',
  'hearing',
  'memory',
  'inference',
  'testimony',
];

/** True when this provenance is achievable by an unaided human player. */
export function isFairPlay(provenance: Provenance): boolean {
  return FAIR_PLAY_PROVENANCE.includes(provenance);
}
