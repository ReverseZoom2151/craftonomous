# Roadmap

Sequencing for Craftonomous. Items move out of this file and into the README's
"what is implemented" list in the same change that makes them true.

The substrate is built and it is now assembled. Almost none of it has been run
against a live Minecraft server, so read the "Shipped" section as "exists,
typechecks and is covered by tests against fakes", not as "known to work in a
real world". Nothing below has a baseline behind it.

## Shipped

### Observation and perception

The provenance contract in `src/observation/` tags every fact with how it was
come by (sight, memory, proprioception, hearing, inference, testimony,
privileged), combines pessimistically, and carries staleness through recall.

`src/perception/gate.ts` enforces a `PerceptionProfile` (`src/perception/profile.ts`,
with `fair-play` and privileged variants) over range, line of sight and memory
horizon. `src/perception/adapter.ts` is the only class permitted to hold a
`SensorPort`; everything above it receives a `WorldView`
(`src/perception/world-view.ts`) and cannot bypass the profile by construction.
`src/perception/memory.ts` is the fixed-horizon world memory, and
`src/perception/ledger.ts` keeps per-provenance tallies, the privileged share
and the fair-play verdict.

Hearing is now a path with something on both ends. `SensorPort` declares
optional `drainSounds()` and `drainChat()` drains, both implemented by the fake
ports and by the mineflayer binding, and `PerceptionAdapter.sounds()` and
`.testimony()` consume them through `gate.hear()`. A drain rather than a getter,
so a caller cannot hear the same creeper forever. `src/perception/testimony.ts`
wraps every utterance as an unverified claim by a named speaker, and its
strongest verdict is `speaker-could-have-known`.

### Embodiment

`src/embodiment/raycast.ts` is an Amanatides and Woo DDA voxel traversal with a
4096-step cap and explicit answers for degenerate rays. It is what makes
`requireLineOfSight` mean something; occlusion is computed, not asserted by the
caller.

`src/embodiment/port.ts` defines `SensorPort` (7 sync reads plus the two
optional event drains), `ActuatorPort` (15 actions) and `EmbodimentPort`.
`src/embodiment/fake/` is a deterministic in-memory voxel world plus ports that
really mutate it and record every action attempted, which is what the skill and
agent tests run against.

`src/embodiment/mineflayer/` implements both ports over mineflayer behind
hand-written structural interfaces, with pathfinder-backed movement, a
`connect()` that retries with backoff (floored at 5 seconds, capped at 5
attempts to respect Mojang's join rate limit) and resolves only after spawn,
XSTS authentication error mapping in `auth-errors.ts`, and entity
classification in `taxonomy.ts`.

`src/embodiment/mineflayer/lifecycle.ts` holds `JoinBudget` and
`SessionSupervisor`: a shared six-per-thirty-seconds join budget, a death and
respawn state machine, and dropped-socket handling. It is written and tested
with an injected clock. It is not yet constructed on the live path; see "Next".

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
settled path.

`src/skills/reliability.ts` ranks and retires skills on a Wilson lower bound,
over a window anchored on the newest attempt rather than on wall-clock now, so a
skill nobody has run lately is not silently emptied of evidence. Every record
can carry an optional context key, and `contextStats` says whether the context's
own evidence answered or whether the overall record had to stand in for it.

`src/skills/library/` registers 18 skills: `goToPosition`, `goToBlock`,
`goToEntity`, `lookAt`, `flee`, `explore`, `digBlock`, `collectBlock`,
`placeBlock`, `craftItem`, `smeltItem`, `equipItem`, `consumeItem`, `dropItem`,
`depositItems`, `withdrawItems`, `attackEntity`, `sendChat`. `explore` lives in
`src/skills/library/exploration.ts` and is in `CORE_SKILLS`, so `RulePolicy`'s
exploration branch now names a skill the registry has.

`src/skills/reflex/` has a priority arbiter and six built-in reflexes
(`in-lava`, `drowning`, `on-fire`, `falling`, `low-health`, `starving`), each
reading only from `WorldView` so a reflex is subject to the same perception
budget as everything else.

### Runtime assembly

`src/runtime/bootstrap.ts` is the assembly layer, and it is what
`src/cli/main.ts` resolves by specifier. `createSession(config)` binds a live
mineflayer body by dynamic import and assembles the stack over it;
`createOfflineSession()` assembles the same stack over the in-memory fake, which
is what makes the wiring testable with no server, no network and no mineflayer
installed. `src/runtime/session.ts` states the contract, and deliberately
exposes no `SensorPort`.

`ContainerTrackingActuators` in the bootstrap wraps the actuator port,
remembers what `openContainer` handed back until `closeContainer` takes it away,
and feeds that to the adapter's `containerSource`. That is the wiring
`depositItems` and `withdrawItems` need to pass their preconditions against a
real body. The remembered view is a snapshot of the moment it was opened and is
not refreshed after a withdraw, because nothing in the sensor contract can
re-read a container.

`src/runtime/supervisor.ts` is the thing that ticks the reflex arbiter, and the
bootstrap starts it by default. `SupervisedInvoker` puts every skill run under
`ReflexSupervisor.guard`, so a firing reflex synchronously aborts whatever is
running while its own action is allowed to take as long as moving a body takes.
No second reflex starts while one is acting.

The bootstrap also accepts `AssembleOptions.lifecycle`, and on a `reconnected`
event it clears world memory and logs how much was forgotten. That consumer is
wired and tested against a fake source. Nothing on the live path emits the event
yet; see "Next".

### Persistence

`src/persistence/` keeps the two things whose loss makes a long run
indistinguishable from a cold start: what the agent has seen, and how well its
skills have actually worked. `snapshot.ts` defines a versioned on-disk schema
(currently version 2, still reading version 1) and a decoder that refuses
anything it does not recognise rather than guessing. `memory-codec.ts` and
`reliability-codec.ts` do the conversions, `capture.ts` does capture and
restore, and `file-store.ts` writes atomically: temporary file in the same
directory, fsync, then rename, with retries for the Windows sharing-violation
case. `sensedAt` is persisted and restored verbatim, so a restore does not turn
hours-old belief into a present-tense sighting.

### MCP surface and CLI

`src/mcp/` exposes the registry as MCP tools with schemas generated from each
skill's zod input (`schema.ts`, `tools.ts`), five resources
(`craftonomous://body`, `inventory`, `surroundings`, `perception`, `skills`)
that carry provenance across the boundary, and a stdio server (`server.ts`).
`manifest.ts` builds the structured run record: outcome, perception report,
reliability table, profile. `offline.ts` provides a body-less mode where every
world read reports unavailable rather than inventing state.

`src/mcp/rate-limit.ts` enforces call budgets, and `server.ts` builds a limiter
sharing the server's clock unless one is explicitly switched off. Two token
buckets, global and per-tool, so one tool hammered in a loop cannot starve the
rest of the body. The limits are set by what is downstream and scarce, the game
server and the Mojang session endpoints, not by this process's own CPU.

`src/cli/main.ts` reads configuration from the environment, refuses nonsense,
and starts the server in either live or offline mode.

### Evaluation

`src/eval/task.ts` defines versioned tasks and manifests with content hashing,
and carries an optional `goalPredicate`. `src/eval/runner.ts` owns budgets,
repeats, deterministic per-attempt seeds and timeout enforcement.
`src/eval/scoring.ts` computes credited outcomes, Wilson lower bounds, false
claims and a discrimination score that punishes both over-attempting and
over-refusing. `src/eval/report.ts` prints the perception profile and
privileged-read share next to every score, and refuses to print a score without
them. Two suites ship in `src/eval/suites/`: 9 gathering tasks and 8 refusal
tasks, 5 of which are impossible.

`src/eval/goal-check.ts` turns a goal into something machine-checkable. Every
shipped task in both suites carries an authored `goalPredicate`, so no shipped
score depends on reading English. A caller override wins, the authored predicate
comes next, and prose parsing survives only as a last-resort fallback for a task
that has neither. The checker reads the world only through a `WorldView`, so
goal checking is under the same sight range, occlusion rules and ledger as the
agent under test, and an unparseable or unanswerable goal returns
`checkable: false` rather than "not met".

Two executors now implement `TaskExecutor`. `src/eval/live.ts` drives an
`AgentLoop` over a caller-supplied session, checks the goal through that
session's own `WorldView`, refuses to run a task under the wrong perception
profile, and records `preparedBy: 'nothing'` on every attempt when the caller
gave it no world reset, because an attempt that inherited the last attempt's
inventory is a different measurement. `src/eval/sandbox-executor.ts` scores the
same suites against the symbolic sandbox with identical outcome mapping,
including the refusal test, so `refused` means the same thing in both tiers.

### Symbolic sandbox

`src/sandbox/` is a geometry-free Minecraft for CI-speed regression. Crafting
recipes are extracted from `minecraft-data` at 1.21.1 (`recipes.ts`), smelting
is hand-authored and validated against the item registry, `techtree.ts` plans
through the cyclic recipe graph with depth and node budgets, and `runner.ts`
scores a policy over `STARTER_TASKS` (6 tasks, 3 of them impossible).

### Live harness

`docker/docker-compose.yml` brings up a pinned, disposable, offline-mode
Minecraft server, tagged to an exact image digest rather than to `latest`, so
the same file next month brings up the same server generating the same world.

`scripts/smoke.mjs` is the first thing to run against it: connect, spawn, body
state, block reads, occlusion, one real movement, clean disconnect, one line per
check, non-zero exit on the first failure. It refuses to run with
`MINECRAFT_AUTH=microsoft` and makes exactly one join attempt, because a smoke
test that loops on real credentials is a way to lose an account.

`tests/live/embodiment.live-test.ts` is the opt-in live suite, gated on
`CRAFTONOMOUS_LIVE=1` and named so the root vitest config does not collect it.
`docs/LIVE_TESTING.md` covers the account rate limit first, then bringing the
server up, the smoke test, the live tests, what to expect the first time, and
troubleshooting.

## Next

### Run against a live server

This is still the headline, and everything else is secondary to it. Nothing in
this repository has ever executed a connect, sense, act, score loop against a
real Minecraft world. The harness for doing it now exists, and has not been
used. Every test still runs against `src/embodiment/fake/` or against the
doubles in `tests/skills/library/harness.ts`. In
`tests/embodiment/mineflayer.test.ts` the only things covered are
`classifyEntity`, `blockIsSolid`, `backoffDelay` and the XSTS error mapping;
`MineflayerSensorPort`, `MineflayerActuatorPort` and `MineflayerEmbodiment` are
exercised by nothing but the opt-in live suite, which has not been run.

The consequence is that there are no baselines. Every number this project can
currently produce was produced against a fake world or the symbolic sandbox.

### Rebind the ports, then activate reconnection

Reconnection is written and inactive. `SessionSupervisor` in
`src/embodiment/mineflayer/lifecycle.ts` handles death, respawn and dropped
sockets, and `connect()` in `binding.ts` never constructs one. That is
deliberate, and the blocker is specific: `MineflayerSensorPort` and
`MineflayerActuatorPort` hold the bot they were constructed with and have no way
to rebind. A supervisor that swapped its bot would leave those ports talking to
a dead socket while reporting a successful recovery, which is worse than not
reconnecting at all.

Port rebinding is therefore the prerequisite, and it is the whole of this item.
The consumer above the gate is already done: `AssembleOptions.lifecycle` in the
bootstrap clears world memory on a `reconnected` event and is tested against a
fake lifecycle source. Once the ports can rebind, `connect()` constructs a
supervisor and hands its event stream to the bootstrap, and nothing above
changes.

### Publish the package

`npm view craftonomous` returns 404, so `npx craftonomous` does not work. The
README currently tells the reader to run `npm run build` and point at
`dist/cli/main.js` instead, which is honest but is not the install anyone wants.

### Make the fake body cost something

`FakeActuatorPort.moveTo` teleports the body: it calls `world.setBody` directly.
The `range` option makes it stop short along the straight line, which mimics a
pathfinder goal, but there is no collision and no traversal. Any skill whose
correctness depends on movement actually being hard is untested, and any
reliability figure measured against the fake is measured in a world where
walking never fails.

### Give the sandbox tier the three goals it cannot score

The symbolic world has no positions, no altitude and no placement action, so
three shipped goals are unscorable there: the crafting table placement goal, the
shelter goal and the altitude goal. `src/eval/sandbox-executor.ts` returns
`error` with a reason for each rather than `failure`, which is the right
behaviour and not a fix. Until the sandbox models position, or those tasks are
scored only in the live tier, a sandbox suite score covers 14 of 17 tasks.

## Known gaps

- Persistence is not wired into a running session. `src/persistence/` can
  capture and restore, and nothing in `src/runtime/`, `src/cli/` or `src/mcp/`
  calls it, so a session still starts ignorant and forgets everything on exit.
- Testimony establishes opportunity, not truth. The strongest verdict
  `src/perception/testimony.ts` will reach is `speaker-could-have-known`, which
  is the honest ceiling without going to look, and a lying agent that was in the
  right place is not caught by it.
- There is no authentication at the MCP boundary. Rate limiting is in, so a
  looping client is bounded; an unauthorised one is not distinguished from an
  authorised one.
- Memory decay is a fixed horizon, not a model of forgetting.
- Mojang's `blockedservers` list is not consulted, so a blocked host fails at
  join time with whatever the server says.
- The container view the bootstrap remembers is not refreshed after a deposit or
  a withdraw, because no sensor read can re-read a container. Inventing the new
  contents would put a fabrication where a measurement belongs, so the snapshot
  is left as the stale thing it is.

## Research directions

Three of these are implemented offline in `src/planning/` and are waiting on a
live game to be worth anything. The implementations are pure and tested against
synthetic data, which proves the algorithm and proves nothing about Minecraft.

Rule mining from failure (`src/planning/rules.ts`) reimplements the WALL-E
pipeline: propose candidate preconditions contrastively from failed and
successful transitions, refine by merging and generalising numeric thresholds,
prune by greedy maximum coverage, then veto actions before they are committed.
The paper demonstrates on a 2D Crafter clone. Whether it survives contact with
real Minecraft preconditions is the open question. The transition log it needs
can now be produced, because `src/eval/live.ts` keeps a trace per attempt, but
no such log exists yet because no live run has happened.

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
