export type { ActionRecord } from './ports.js';
export {
  FakeActuatorPort,
  FakeEmbodiment,
  FakeSensorPort,
  createFakeEmbodiment,
} from './ports.js';

export type { BlockOptions, FakeRecipe } from './world.js';
export {
  AIR,
  EVENT_BUFFER_LIMIT,
  EYE_HEIGHT,
  FakeWorld,
  pushBounded,
} from './world.js';
