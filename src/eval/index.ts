/**
 * Evaluation harness.
 *
 * Deterministic scoring, versioned task manifests with content hashes, and
 * reports that cannot print a score without the perception profile it was
 * earned under.
 */

export type { Budget, Difficulty, Task, TaskManifest } from './task.js';
export {
  DIFFICULTIES,
  defineManifest,
  defineTask,
  findTask,
  hashManifest,
  requiredProfiles,
} from './task.js';

export type {
  Aggregate,
  OutcomeKind,
  ScoredOutcome,
  SuiteScore,
  TaskOutcome,
  TaskScore,
} from './scoring.js';
export {
  OUTCOME_KINDS,
  aggregate,
  isCredited,
  scoreByTask,
  scoreOutcome,
  scoreSuite,
  wilsonLowerBound,
} from './scoring.js';

export type {
  AttemptContext,
  AttemptRecord,
  RunOptions,
  SuiteRun,
  TaskExecutor,
} from './runner.js';
export { runSuite } from './runner.js';

export type {
  GoalCheck,
  GoalParse,
  GoalPredicate,
  GoalPredicateOverrides,
} from './goal-check.js';
export {
  ITEM_TAGS,
  checkPredicate,
  checkPredicateAgainstItems,
  checkTaskGoal,
  describePredicate,
  normaliseItemName,
  parseGoal,
  predicateFor,
} from './goal-check.js';

export type {
  LiveAttemptRecord,
  LiveExecutorDeps,
  LiveSession,
  RecordingExecutor,
} from './live.js';
export {
  createLiveExecutor,
  declaresImpossible,
  traceDeclaresImpossible,
} from './live.js';

export type {
  RecordingSandboxExecutor,
  SandboxAttemptRecord,
  SandboxExecutorDeps,
  SandboxScenario,
} from './sandbox-executor.js';
export { createSandboxExecutor } from './sandbox-executor.js';

export type {
  ReliabilityRow,
  ReportInputs,
  RunReport,
  RunReportJSON,
} from './report.js';
export { buildReport, formatReport, toJSON } from './report.js';

export {
  BUILTIN_SUITES,
  GATHERING_SUITE,
  GATHERING_TASKS,
  REFUSAL_SUITE,
  REFUSAL_TASKS,
  suiteByName,
} from './suites/index.js';
