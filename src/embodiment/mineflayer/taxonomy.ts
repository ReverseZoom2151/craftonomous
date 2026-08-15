import type { EntityKind } from '../types.js';

/**
 * Entity classification, kept out of the binding so it can be tested without a
 * server. The substrate's own `type` field is inconsistent across versions and
 * across mob categories, so the name is treated as the more reliable signal and
 * the type only as a fallback.
 */

/** Mobs that will attack an unprovoked player. */
const HOSTILE = new Set([
  'blaze',
  'bogged',
  'breeze',
  'cave_spider',
  'creeper',
  'drowned',
  'elder_guardian',
  'ender_dragon',
  'endermite',
  'evoker',
  'ghast',
  'guardian',
  'hoglin',
  'husk',
  'illusioner',
  'magma_cube',
  'phantom',
  'piglin_brute',
  'pillager',
  'ravager',
  'shulker',
  'silverfish',
  'skeleton',
  'slime',
  'stray',
  'vex',
  'vindicator',
  'warden',
  'witch',
  'wither',
  'wither_skeleton',
  'wither_skull',
  'zoglin',
  'zombie',
  'zombie_villager',
  'zombified_piglin',
]);

/** Mobs that turn hostile only once attacked. Reported as not hostile. */
const NEUTRAL = new Set([
  'bee',
  'dolphin',
  'enderman',
  'goat',
  'iron_golem',
  'llama',
  'panda',
  'piglin',
  'polar_bear',
  'spider',
  'trader_llama',
  'wolf',
]);

/** Passive creatures. */
const ANIMAL = new Set([
  'allay',
  'armadillo',
  'axolotl',
  'bat',
  'camel',
  'cat',
  'chicken',
  'cod',
  'cow',
  'donkey',
  'fox',
  'frog',
  'glow_squid',
  'horse',
  'mooshroom',
  'mule',
  'ocelot',
  'parrot',
  'pig',
  'pufferfish',
  'rabbit',
  'salmon',
  'sheep',
  'skeleton_horse',
  'sniffer',
  'snow_golem',
  'squid',
  'strider',
  'tadpole',
  'tropical_fish',
  'turtle',
  'villager',
  'wandering_trader',
  'zombie_horse',
]);

/** Non-living entities that are nonetheless worth noticing. */
const OBJECT_TYPES = new Set([
  'object',
  'orb',
  'projectile',
  'global',
  'other',
  'boat',
  'minecart',
  'arrow',
  'experience_orb',
  'falling_block',
  'tnt',
  'armor_stand',
  'painting',
  'item_frame',
]);

export interface EntityClassification {
  readonly kind: EntityKind;
  readonly hostile: boolean;
}

/** Strip a namespace and normalise, so `minecraft:Zombie` reads as `zombie`. */
export function normaliseEntityName(name: string): string {
  const withoutNamespace = name.includes(':')
    ? (name.split(':').at(-1) ?? name)
    : name;
  return withoutNamespace.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Classify an entity from whatever the substrate offers.
 *
 * `username` present means a player, unconditionally: that is the one signal no
 * version of the protocol muddles.
 */
export function classifyEntity(input: {
  readonly name?: string | undefined;
  readonly type?: string | undefined;
  readonly username?: string | undefined;
}): EntityClassification {
  if (input.username !== undefined && input.username !== '') {
    return { kind: 'player', hostile: false };
  }

  const name = normaliseEntityName(input.name ?? '');
  const type = normaliseEntityName(input.type ?? '');

  if (type === 'player') return { kind: 'player', hostile: false };
  if (name === 'item' || name === 'item_entity' || type === 'item') {
    return { kind: 'item', hostile: false };
  }

  if (HOSTILE.has(name)) return { kind: 'mob', hostile: true };
  if (NEUTRAL.has(name)) return { kind: 'mob', hostile: false };
  if (ANIMAL.has(name)) return { kind: 'animal', hostile: false };

  if (type === 'hostile') return { kind: 'mob', hostile: true };
  if (type === 'animal' || type === 'passive' || type === 'water_creature') {
    return { kind: 'animal', hostile: false };
  }
  if (type === 'mob' || type === 'living') return { kind: 'mob', hostile: false };
  if (OBJECT_TYPES.has(type) || OBJECT_TYPES.has(name)) {
    return { kind: 'object', hostile: false };
  }

  return { kind: 'other', hostile: false };
}
