/**
 * The reference agent.
 *
 * It exists to prove the substrate is usable, not to be the product. Every
 * piece here is a client of the same surface any other agent gets: it reads the
 * world through an injected `WorldView` and acts through an injected
 * `SkillInvoker`. It never holds a sensor port or a bot handle, so a run's
 * perception report is a fact about the agent rather than a hope.
 */

export type {
  DigestElision,
  DigestOptions,
  ObservationDigest,
} from './observation-digest.js';
export {
  buildDigest,
  digestText,
  formatAge,
  formatPosition,
  provenanceTag,
} from './observation-digest.js';

export type {
  AgentMemoryOptions,
  Fact,
  MemorySnapshot,
  NamedLocation,
  Summariser,
  Turn,
  TurnRole,
} from './memory.js';
export { AgentMemory, createSummariser } from './memory.js';

export type {
  Goal,
  GoalStackOptions,
  GoalStatus,
  PushOptions,
} from './goal.js';
export { GoalDepthExceeded, GoalStack } from './goal.js';

export type {
  Decision,
  InvocationResult,
  Policy,
  PolicyInput,
  RulePolicyOptions,
  RuleSkillNames,
  SkillDescriptor,
  SkillInvoker,
  StepOutcome,
  GatherGoal,
} from './policy.js';
export {
  DEFAULT_FOODS,
  DEFAULT_RULE_SKILLS,
  RulePolicy,
  ScriptedPolicy,
  describeDecision,
  describeOutcome,
  doneDecision,
  parseGatherGoal,
  skillDecision,
} from './policy.js';

export type {
  LanguageModel,
  LlmMessage,
  LlmPolicyOptions,
  LlmRole,
  ParseOptions,
  PromptOptions,
  ToolSpec,
} from './llm.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  LlmPolicy,
  buildPrompt,
  parseDecision,
  toolSpecs,
} from './llm.js';

export type {
  AgentLoopOptions,
  RunTrace,
  StopReason,
  TraceStep,
} from './loop.js';
export { AgentLoop, formatTrace } from './loop.js';
