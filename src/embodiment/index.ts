/**
 * Embodiment: the body, and the raw sensor interface behind the gate.
 *
 * This entry point is separate from the package root on purpose. Everything
 * here can reach the world without a perception profile, so importing it is a
 * deliberate act. Anything building an agent wants `WorldView` from the root
 * instead.
 */
export * from './geometry.js';
export * from './types.js';
export * from './port.js';
export * from './raycast.js';
export * from './fake/index.js';
export * from './mineflayer/index.js';
