import type { SkillRegistry } from '../registry.js';
import type { AnySkill, Skill } from '../types.js';
import { placeBlock } from './building.js';
import { attackEntity } from './combat.js';
import { depositItems, withdrawItems } from './containers.js';
import { craftItem, smeltItem } from './crafting.js';
import { consumeItem, dropItem, equipItem } from './inventory.js';
import { collectBlock, digBlock } from './mining.js';
import { flee, goToBlock, goToEntity, goToPosition, lookAt } from './movement.js';
import { sendChat } from './social.js';

export * from './building.js';
export * from './combat.js';
export * from './containers.js';
export * from './crafting.js';
export * from './inventory.js';
export * from './mining.js';
export * from './movement.js';
export * from './social.js';

/**
 * Erase a skill's input and output types for storage.
 *
 * `AnySkill` exists so a registry can hold skills of differing shapes; the cast
 * is the price of that, and it is confined to this one function rather than
 * scattered across every call site.
 */
function erase<I, O>(skill: Skill<I, O>): AnySkill {
  return skill as unknown as AnySkill;
}

/**
 * The skills every embodiment ships with.
 *
 * Deliberately small. A skill in this list is expected to carry a measured
 * reliability figure, and a long list of unmeasured skills is worth less than a
 * short list of known ones. See ARCHITECTURE.md on why the library is narrow
 * and deep rather than a port of somebody else's 205.
 */
export const CORE_SKILLS: readonly AnySkill[] = [
  // movement
  erase(goToPosition),
  erase(goToBlock),
  erase(goToEntity),
  erase(lookAt),
  erase(flee),
  // mining
  erase(digBlock),
  erase(collectBlock),
  // building
  erase(placeBlock),
  // crafting
  erase(craftItem),
  erase(smeltItem),
  // inventory
  erase(equipItem),
  erase(consumeItem),
  erase(dropItem),
  // containers
  erase(depositItems),
  erase(withdrawItems),
  // combat
  erase(attackEntity),
  // social
  erase(sendChat),
];

/** Register every core skill. Throws `DuplicateSkill` if one is already there. */
export function registerCoreSkills(registry: SkillRegistry): SkillRegistry {
  return registry.registerAll(CORE_SKILLS);
}
