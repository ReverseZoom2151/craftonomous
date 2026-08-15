import type { TaskManifest } from '../task.js';
import { GATHERING_SUITE } from './gathering.js';
import { REFUSAL_SUITE } from './refusal.js';

export { GATHERING_SUITE, GATHERING_TASKS } from './gathering.js';
export { REFUSAL_SUITE, REFUSAL_TASKS } from './refusal.js';

/** Every starter manifest that ships with Craftonomous. */
export const BUILTIN_SUITES: readonly TaskManifest[] = [
  GATHERING_SUITE,
  REFUSAL_SUITE,
];

export function suiteByName(name: string): TaskManifest | undefined {
  return BUILTIN_SUITES.find((s) => s.name === name);
}
