/**
 * The research layer: planning, rule learning and a correctable world model.
 *
 * Everything here is a pure offline algorithm. No mineflayer, no server, no
 * network, no model SDK. Where a model would be used it arrives as an injected
 * function, so every claim in this directory is testable in milliseconds and
 * reproducible without a Minecraft install. That is deliberate: the survey's
 * planning work is mostly unreproducible because the algorithm and the game are
 * welded together.
 */

export type { TaskNode, TaskSpec, TaskStatus } from './dag.js';
export { CycleError, TaskGraph } from './dag.js';

export type {
  DecomposeOptions,
  DecomposeResult,
  ExpandContext,
  Expander,
  StopReason,
} from './decomposer.js';
export { decompose, normaliseGoal } from './decomposer.js';

export type {
  Condition,
  ConditionOp,
  Measurement,
  MiningReport,
  ProposalInput,
  Proposer,
  PruneOptions,
  PruneResult,
  Refiner,
  Rule,
  RuleDraft,
  RuleMinerOptions,
  RuleVerdict,
  State,
  Transition,
} from './rules.js';
export {
  RuleMiner,
  apply,
  condition,
  conditionId,
  contrastiveProposer,
  measure,
  mergeRefiner,
  prune,
  testCondition,
  toRule,
} from './rules.js';

export type {
  Edge,
  EdgeKey,
  EdgeSeed,
  EdgeSource,
  KnowledgeGraphOptions,
  Observation,
  Relation,
} from './knowledge-graph.js';
export { KnowledgeGraph, edgeKey } from './knowledge-graph.js';
