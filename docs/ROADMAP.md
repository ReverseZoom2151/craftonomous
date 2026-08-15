# Roadmap

Sequencing for Craftonomous. Items move out of this file and into the README's
"what is implemented" list in the same change that makes them true.

The substrate is built. Almost none of it has been run against a live Minecraft
server, so read the "Shipped" section as "exists, typechecks and is covered by
tests against fakes", not as "known to work in a real world".

## Shipped

### Observation and perception

The provenance contract in `src/observation/` tags every fact with how it was
come by (sight, memory, proprioception, hearing, inference, testimony,
privileged), combines pessimistically, and carries staleness through recall.

`src/perception/gate.ts` enforces a `PerceptionProfile` (`src/perception/profile.ts`,
with `fair-play`, and privileged variants) over range, line of sight and memory
horizon. `src/perception/adapter.ts` is the only class permitted to hold a
`SensorPort`; everything above it receives a `WorldView`
(`src/perception/world-view.ts`) and cannot bypass the profile by construction.
`src/perception/memory.ts` is the fixed-horizon world memory, and
`src/perception/ledger.ts` keeps per-provenance tallies, the privileged share
and the fair-play verdict.

### Embodiment

`src/embodiment/raycast.ts` is an Amanatides and Woo DDA voxel traversal with a
4096-step cap and explicit answers for degenerate rays. It is what makes
`requireLineOfSight` mean something; occlusion is computed, not asserted by the
caller.

`src/embodiment/port.ts` defines `SensorPort` (7 sync reads), `ActuatorPort`
(16 async actions) and `EmbodimentPort`. `src/embodiment/fake/` is a
deterministic in-memory voxel world plus ports that really mutate it and record
every action attempted, which is what the skill and agent tests run against.

`src/embodiment/mineflayer/` implements both ports over mineflayer behind
hand-written structural interfaces, with pathfinder-backed movement, a
`connect()` that retries with backoff (floored at 5 seconds, capped at 5
attempts to respect Mojang's join rate limit) and resolves only after spawn,
XSTS authentication error mapping in `auth-errors.ts`, and entity
classification in `taxonomy.ts`.

### Skills

`src/skills/types.ts` defines the skill contract with an 8-value failure
taxonomy (`timeout`, `precondition`, `unreachable`, `interrupted`,
`world-changed`, `invalid-input`, `not-permitted`, `unknown`) and a declared
retryable subset. A `SkillContext` is handed a `WorldView`, never a
`SensorPort`.

`src/skills/runner.ts` is the invocation wrapper: registry lookup, abort checks,
retirement refusal, a repetition guard, zod input and output validation, a
30-second default timeout composed with the caller's signal, precondition
evaluation, throw-to-failure conversion and reliability recording on every
settled path. `src/skills/reliability.ts` ranks and retires skills on a Wilson
lower bound.

`src/skills/library/` registers 17 skills: `goToPosition`, `goToBlock`,
`goToEntity`, `lookAt`, `flee`, `digBlock`, `collectBlock`, `placeBlock`,
`craftItem`, `smeltItem`, `equipItem`, `consumeItem`, `dropItem`,
`depositItems`, `withdrawItems`, `attackEntity`, `sendChat`.

`src/skills/reflex/` has a priority arbiter and six built-in reflexes
(`in-lava`, `drowning`, `on-fire`, `falling`, `low-health`, `starving`), each
reading only from `WorldView` so a reflex is subject to the same perception
budget as everything else.

### MCP surface and CLI

`src/mcp/` exposes the registry as MCP tools with schemas generated from each
skill's zod input (`schema.ts`, `tools.ts`), five resources
(`craftonomous://body`, `inventory`, `surroundings`, `perception`, `skills`)
that carry provenance across the boundary, and a stdio server (`server.ts`).
`manifest.ts` builds the structured run record: outcome, perception report,
reliability table, profile. `offline.ts` provides a body-less mode where every
world read reports unavailable rather than inventing state.

`src/cli/main.ts` reads configuration from the environment, refuses nonsense,
and starts the server in either live or offline mode.

### Evaluation

`src/eval/task.ts` defines versioned tasks and manifests with content hashing.
`src/eval/runner.ts` owns budgets, repeats, deterministic per-attempt seeds and
timeout enforcement. `src/eval/scoring.ts` computes credited outcomes, Wilson
lower bounds, false claims and a discrimination score that punishes both
over-attempting and over-refusing. `src/eval/report.ts` prints the perception
profile and privileged-read share next to every score, and refuses to print a
score without them. Two suites ship in `src/eval/suites/`: 9 gathering tasks and
8 refusal tasks, 5 of which are impossible.

### Symbolic sandbox

`src/sandbox/` is a geometry-free Minecraft for CI-speed regression. Crafting
recipes are extracted from `minecraft-data` at 1.21.1 (`recipes.ts`), smelting
is hand-authored and validated against the item registry, `techtree.ts` plans
through the cyclic recipe graph with depth and node budgets, and `runner.ts`
scores a policy over `STARTER_TASKS` (6 tasks, 3 of them impossible).

### Reference agent and planning

`src/agent/` is an in-process reference agent: a step loop with budget and abort
handling, a goal stack, rolling-summary memory, a provenance-tagged observation
digest, a `ScriptedPolicy`, a survival-first `RulePolicy`, and an `LlmPolicy`
over a `LanguageModel` interface with tolerant decision parsing. No provider SDK
is imported.

`src/planning/` holds offline implementations of the research directions:
`dag.ts` (task graph with atomic subgraph splicing and cycle detection),
`decomposer.ts` (bounded incremental decomposition), `knowledge-graph.ts`
(log-odds recipe-graph repair where a contradicted seed can fall out of belief),
and `rules.ts` (propose, refine, prune-by-coverage precondition mining that
produces machine-checkable rules, not sentences).

## Next

### Run against a live server

Nothing in this repository has ever executed a connect, sense, act, score loop
against a real Minecraft world. Every test runs against `src/embodiment/fake/`
or against the doubles in `tests/skills/library/harness.ts`. In
`tests/embodiment/mineflayer.test.ts` the only things covered are
`classifyEntity`, `blockIsSolid`, `backoffDelay` and the XSTS error mapping;
`MineflayerSensorPort`, `MineflayerActuatorPort`, `MineflayerEmbodiment`,
`connect`, `attemptConnect` and `waitForSpawn` are untested and unmocked, and
nothing in `src/` calls `connect()` at all.

The consequence is that there are no baselines. Every number this project can
currently produce was produced by a stub executor against a fake world.
Everything else below is secondary to fixing that.

### `src/runtime/bootstrap.ts` does not exist

`src/cli/main.ts` resolves a bootstrap module by specifier at runtime
(`DEFAULT_BOOTSTRAP = '../runtime/bootstrap.js'`, overridable with
`CRAFTONOMOUS_BOOTSTRAP`) and expects it to export
`createSession(config): Session`, returning a registry, an invoker, a
`WorldView` and a reliability tracker. `src/runtime/` contains only `clock.ts`
and `logger.ts`. That missing file is the entire reason the MCP server always
starts in offline mode: `loadSession` fails the dynamic import, reports the
reason to stderr and falls back to `OfflineInvoker` and `OfflineWorldView`.

Writing it means calling `connect()` from `src/embodiment/mineflayer/binding.ts`,
building a `PerceptionGate` and `WorldMemory` from the configured profile,
constructing a `PerceptionAdapter` over the live `SensorPort`, registering the
core skills, and wiring a `SkillRunner` as the invoker.

### There is no live eval executor

`src/eval/runner.ts` takes an injected `TaskExecutor`, which is the right shape:
the harness stays agent-agnostic. But no implementation of that type exists
anywhere outside tests, and the ones in `tests/eval/harness.test.ts` are stubs
that return a hardcoded outcome. Nothing drives a real bot through a task and
evaluates its goal.

Note also that `Task.goal` in `src/eval/task.ts` is a human-readable string by
design, with the predicate meant to be evaluated by the executor against real
game state. No such predicate evaluation exists. So the harness can score
outcomes it is handed, but it cannot currently score a real run, because nothing
can produce one and nothing can check one.

### The reflex arbiter is unwired

`ReflexArbiter` is constructed in `tests/skills/reflex.test.ts` and nowhere
else. `src/agent/loop.ts` mentions reflexes only in a comment; its sole
pre-emption path is the externally injected `AbortSignal`. `src/skills/runner.ts`
does not tick it either. So the six built-in reflexes are exercised in isolation
and are correct in isolation, but nothing in the running system ever calls
`evaluate()` or `preempt()`. Whatever ticks it should live next to the loop that
owns the running skill's `AbortController`.

### `PerceptionAdapter` container source is never injected

`PerceptionAdapterOptions.containerSource` is supplied only in
`tests/perception/adapter.test.ts`. There is no production wiring at all, since
nothing in `src/` constructs a `PerceptionAdapter`. Containers are opened
through the actuators, so the bootstrap module is where the open-container
lookup has to be threaded from the actuator back into the adapter. Until it is,
`openContainer()` will always report nothing open, and `depositItems` and
`withdrawItems` will fail their preconditions against a live body.

### Nothing produces `hearing` observations

`hearing` is a declared provenance in `src/observation/provenance.ts`, is
weighted in `observed.ts`, has a `hearingRange` in every profile, has a
`gate.hear()` method, is rendered as `[heard]` by
`src/agent/observation-digest.ts` and is printed by `src/eval/report.ts`. No
caller ever invokes `gate.hear()`. `SoundEvent` is declared in
`src/embodiment/types.ts` but neither `SensorPort` nor either implementation
produces one. The whole hearing path is a contract with nothing on the other
end.

## Known gaps

- There is no `explore` skill. `DEFAULT_RULE_SKILLS` in `src/agent/policy.ts`
  names `'explore'`, so `RulePolicy`'s exploration branch emits a skill the
  registry will reject as unknown.
- No rate limiting or authentication at the MCP boundary.
  `src/mcp/tools.ts` marks the spot where a call budget would sit; a looping or
  hostile client can invoke as fast as the body responds.
- Reliability has no recency weighting and no per-context conditioning. A skill
  that worked a thousand times in a forest and fails in a cave gets one number.
- Testimony is unverified. A lying agent is believed.
- `FakeActuatorPort.moveTo` teleports the body (it calls `world.setBody`
  directly) rather than pathfinding. The `range` option makes it stop short
  along the straight line, which mimics a pathfinder goal, but there is no
  collision and no traversal. Any skill whose correctness depends on movement
  actually being hard is untested.
- The mineflayer binding has no respawn handling and no reconnect after a drop.
  `connect()` retries an initial join; once `'end'` fires, `MineflayerEmbodiment`
  simply reports `connected === false`. There is no death handler.
- Memory decay is a fixed horizon, not a model of forgetting.
- Mojang's `blockedservers` list is not consulted, so a blocked host fails at
  join time with whatever the server says.

## Research directions

Three of these are implemented offline in `src/planning/` and are waiting on a
live game to be worth anything. The implementations are pure and tested against
synthetic data, which proves the algorithm and proves nothing about Minecraft.

Rule mining from failure (`src/planning/rules.ts`) reimplements the WALL-E
pipeline: propose candidate preconditions contrastively from failed and
successful transitions, refine by merging and generalising numeric thresholds,
prune by greedy maximum coverage, then veto actions before they are committed.
The paper demonstrates on a 2D Crafter clone. Whether it survives contact with
real Minecraft preconditions is the open question, and it cannot be answered
without a transition log from a real world, which requires the live loop above.

Experience-corrected knowledge graph (`src/planning/knowledge-graph.ts`) keeps a
hypothesised recipe graph as a prior in log-odds and repairs it from what
actually happened, with saturation limits so no belief becomes unfalsifiable and
a confidently-seeded edge can be unlearned. Currently it can only be corrected
by the symbolic sandbox, where the seed and the ground truth come from the same
`minecraft-data` extraction, so the interesting case (a prior that is wrong
about a real game version) has never been tested.

Skill boundaries from surprisal is not implemented. It needs recorded gameplay
segmented by a frozen policy's own prediction loss, and there are no recordings
because there have been no live runs.

Task-DAG planning (`src/planning/dag.ts` and `decomposer.ts`) is the one that is
genuinely usable offline: the graph, the bounded lookahead and the atomic
subgraph splice are exercised against synthetic expanders. It becomes research
rather than plumbing only when there are several agents and a real world to
schedule them in.
