# Architecture

## Shape

```text
┌─────────────────────────────────────────────┐
│  any agent  (Claude Code, Codex, LangGraph, │
│              a local Ollama loop, a human)  │
└───────────────────┬─────────────────────────┘
                    │  Model Context Protocol, over stdio
┌───────────────────▼─────────────────────────┐
│  MCP surface            src/mcp/            │
│    tools: skills        resources: 5 URIs   │
└───────────────────┬─────────────────────────┘
┌───────────────────▼─────────────────────────┐
│  skill layer            src/skills/         │
│    schema · timeout · interrupt · reflexes  │
│    repetition guard · reliability           │
└────────┬──────────────────────────┬─────────┘
         │ WorldView (knowing)      │ ActuatorPort (doing)
┌────────▼──────────────────┐       │
│  perception               │       │  deliberately
│    src/perception/        │       │  not gated
│    gate ◄── profile       │       │
│    adapter ──► ledger     │       │
│            ──► memory     │       │
└────────┬──────────────────┘       │
┌────────▼──────────────────────────▼─────────┐
│  embodiment             src/embodiment/     │
│    SensorPort            ActuatorPort       │
│    mineflayer/ (live)    fake/ (tests)      │
└───────────────────┬─────────────────────────┘
                    │  Minecraft protocol
              ┌─────▼──────┐
              │   server   │
              └────────────┘
```

The load-bearing constraint: nothing above the perception gate may reach past
it for knowledge. Skills do not hold a reference to the bot. If they did, the
ledger would be fiction and the profile unenforceable.

## Why the agent sits outside

Five projects in the [survey](PRIOR_ART.md) independently started pulling agent
reasoning out of the Minecraft integration: haksnbot, clawcraft,
gemini-minecraft, justjavac's minecraft-agent, and plancraft. None finished.
The pattern keeps recurring because the coupling is genuinely wrong: a bot
framework that owns its own LLM loop can only ever be evaluated as a whole, and
its skill library cannot be reused by anyone whose agent works differently.

Craftonomous owns the body and refuses to own the brain. A reference agent
ships in `src/agent/` to prove the substrate works, and it is a client of the
same `WorldView` and skill invoker everyone else gets, with no privileged
in-process access.

## Sensing and actuation are split on purpose

`src/embodiment/port.ts` declares two separate interfaces rather than one bot
handle.

`SensorPort` is raw and ungated: `body`, `blockAt`, `entities`, `inventory`,
`equipment`, `isOccluded` and `findBlocks` answer without regard to any
profile. Only `PerceptionAdapter` in `src/perception/adapter.ts` may hold one.
Everything above it (skills, the reflex arbiter, the MCP surface, the reference
agent) receives a `WorldView` from `src/perception/world-view.ts` and nothing
else. An ungated read anywhere above that line would bypass the active
`PerceptionProfile` and leave `PerceptionLedger` reporting a fiction about what
the agent actually knew.

`ActuatorPort` is deliberately not gated. Doing a thing is not knowing a thing,
and an agent is always permitted to act on the world. What it may learn is
governed by the gate; what it may attempt is not. `SkillContext` in
`src/skills/types.ts` shows the shape this produces: it carries `world` (a
`WorldView`), `act` (an `ActuatorPort`), a `Clock`, a `Logger` and an
`AbortSignal`, and there is no field of type `SensorPort` anywhere in it.

This is enforced by construction rather than by convention. Nothing above the
gate is ever handed the port to begin with, so there is no discipline to
forget. `createServer` in `src/mcp/server.ts` takes no `SensorPort` parameter,
and `AgentLoop` in `src/agent/loop.ts` holds a `WorldView` and a skill invoker
and nothing else.

The package layout backs this up. `src/index.ts` exports `SensorPort` as a
type, but the implementations that satisfy it, `MineflayerSensorPort` in
`src/embodiment/mineflayer/binding.ts` and `FakeSensorPort` in
`src/embodiment/fake/ports.ts`, are reachable only through the
`craftonomous/embodiment` subpath in the `exports` map of `package.json`.
Importing one is a deliberate act rather than something autocomplete does for
you.

## Layers

### Embodiment

`src/embodiment/` holds the geometry helpers, the world value types
(`BlockInfo`, `BodyState`, `EntityInfo`, `ItemStack`, `ContainerView`) and the
two ports. Two implementations exist. `src/embodiment/mineflayer/` is the live
binding: `binding.ts` provides `MineflayerSensorPort`, `MineflayerActuatorPort`
and `MineflayerEmbodiment` with a `connect` helper and exponential-backoff
reconnect, `auth-errors.ts` turns XSTS failures into messages that say what to
do, and `taxonomy.ts` classifies entities by name. `src/embodiment/fake/` is an
in-memory world used by the tests, which is what lets the perception and skill
layers be tested with no server, no Java and no network.

`src/embodiment/raycast.ts` is an Amanatides and Woo voxel DDA traversal with a
hard step cap of 4096. It is what makes `requireLineOfSight` real; without it
the `fair-play` profile would be a contract with no enforcer.

mineflayer was chosen over the MineRL and Malmo family for reasons recorded in
the [survey](PRIOR_ART.md): it tracks current Minecraft versions (1.8 through
1.21.11), needs no JDK, and is MIT with no NonCommercial ancestry. The MineRL
family is pinned to Minecraft 1.16.5 and JDK 8, and minerl itself is
CC BY-NC-SA.

### Perception

Described in full in [perception](PERCEPTION.md). `PerceptionProfile` in
`src/perception/profile.ts` declares sight range, whether line of sight is
required, hearing range, a memory horizon and whether privileged reads are
allowed. Three ship: `FAIR_PLAY` (64 blocks, occlusion enforced, ten minute
memory), `XRAY` (same range, occlusion ignored, for separating planning ability
from exploration ability) and `OMNISCIENT` (no restriction, named so that
choosing it is visible).

`PerceptionGate` in `src/perception/gate.ts` enforces the profile and records
every read. `sense` throws `PerceptionDenied` on a privileged read under a
profile that forbids one, rather than silently returning less. `sight` returns
`undefined` when range or occlusion fails, which callers must read as "not
known" rather than "not there".

`PerceptionAdapter` is the only class permitted to hold a `SensorPort`. It puts
every raw fact through the gate, writes sightings into `WorldMemory`
(`src/perception/memory.ts`), and falls back to memory when sight fails.
Recollections are re-tagged with provenance `memory` and keep the moment they
were originally sensed, so a ten minute old recollection can never be mistaken
for a present-tense sighting. `findBlocks` oversamples raw candidates by four
because occlusion throws most of them away, which otherwise makes a profile
look like a shortage of ore rather than a shortage of sight.

`PerceptionLedger` in `src/perception/ledger.ts` tallies reads by provenance and
produces a `PerceptionReport` with totals, the privileged share and a
`fairPlay` verdict. The seven provenance kinds are listed in
`src/observation/provenance.ts`: proprioception, sight, hearing, memory,
inference, testimony and privileged. The first six are what an unaided human
player could achieve; `privileged` is permitted but always counted.

### Skill layer

A skill, defined in `src/skills/types.ts`, is a named operation with a summary,
a description, zod schemas for input and output, an optional time budget, an
optional precondition and a `run` method returning `SkillResult`.

`SkillRegistry` in `src/skills/registry.ts` stores and looks up, and does
nothing else. Everything that makes a call trustworthy lives in `SkillRunner`
in `src/skills/runner.ts`, which is the only place allowed to run a skill: it
validates input against the schema, checks the precondition, applies a time
budget (30 seconds when the skill declares none), folds the caller's abort
signal together with the timeout so a reflex pre-emption reaches the skill body,
validates output on the way back, and records the attempt with the reliability
tracker. It also refuses a skill invoked eight consecutive times with the same
input and no success, which is the exact loop prior agents wedge in.

`src/skills/reflex/` is the always-ticking layer that can pre-empt a running
skill. `types.ts` requires `shouldFire` to be synchronous and side-effect free,
because a reflex that reasons is not a reflex. `builtin.ts` ships responses to
lava, drowning, fire, falling, low health and starvation, and `REFLEX_PRIORITY`
orders them by how fast the situation kills you. `arbiter.ts` picks the winner.

`src/skills/reliability.ts` tracks per-skill attempts and successes and ranks on
a Wilson score lower bound at 95% confidence rather than the naive rate, because
the naive rate is maximally wrong exactly when there is least evidence. The
default retirement policy retires a skill after at least 8 attempts once
confidence falls below 0.25. More in [skill reliability](SKILL_RELIABILITY.md).

`src/skills/library/` holds seventeen core skills, listed in `CORE_SKILLS`:
`goToPosition`, `goToBlock`, `goToEntity`, `lookAt`, `flee`, `digBlock`,
`collectBlock`, `placeBlock`, `craftItem`, `smeltItem`, `equipItem`,
`consumeItem`, `dropItem`, `depositItems`, `withdrawItems`, `attackEntity` and
`sendChat`. The library is narrow on purpose. Odyssey publishes 205 mineflayer
skills under MIT; we do not port them, because a small set with measured
reliability is worth more here than a large set with none.

Two ideas here are taken from prior art and reimplemented rather than copied.
mindcraft wraps every skill call with timeout, interrupt and loop detection and
keeps a reflex layer that can override the planner. minecraft-agent-swarm
tracks per-skill success rates and retires skills that stop working, which is
the feedback loop the Voyager lineage never closed.

### Failure taxonomy

`FailureKind` in `src/skills/types.ts` names why a skill did not succeed.
`RETRYABLE_FAILURES` and `isRetryable` in the same file decide the retryable
column, and `fail()` stamps it onto every failure result.

| Kind | Meaning | Retryable |
| --- | --- | --- |
| `timeout` | Ran past its time budget. | yes |
| `unreachable` | The target could not be reached. | yes |
| `world-changed` | The target block or entity is gone. | yes |
| `precondition` | A stated precondition did not hold when checked. | no |
| `interrupted` | Pre-empted by a reflex or an explicit cancellation. | no |
| `invalid-input` | Input failed schema validation. | no |
| `not-permitted` | The perception profile forbade a read the skill required. | no |
| `unknown` | Everything else. Expected to shrink over time. | no |

Collapsing all of these into a boolean throws away the only information that
would tell an agent what to do next. Retrying is right for a timeout and wrong
for a precondition. A precondition failure means re-plan, because the world is
not in the state the plan assumed. `not-permitted` means neither: the agent did
not fail at the task, it was not allowed to look, and the fix is a different
approach or a different profile rather than another attempt. `invalid-input`
means the call itself was malformed and the same call will always fail. A
result that says only "it failed" leaves an agent with nothing to decide on.

Every failure carries `kind`, `message`, `retryable` and `durationMs`, and the
retryable flag is derived rather than supplied, so a skill author cannot get it
inconsistent with the kind.

### MCP surface

`src/mcp/` exposes the body so any agent can drive it. `src/cli/main.ts` starts
it over stdio.

`schema.ts` converts a skill's zod schemas to JSON Schema with every `$ref`
inlined, checks names against the character set MCP permits, and wraps a
non-object input under a single `value` key because MCP requires an object at
the root of `inputSchema`. `tools.ts` holds `ToolDispatcher`, which lists tools
sorted by name (deterministic on purpose, since clients cache tool lists and
models cache the prompt prefix containing them) and dispatches calls to the
skill runner. `resources.ts` serves five URIs: `craftonomous://body`,
`://inventory`, `://surroundings`, `://perception` and `://skills`. Every value
crossing that boundary carries its provenance, its `sensedAt` timestamp and a
`fairPlay` flag. `manifest.ts` builds the run manifest: outcome, the full
profile, the perception report, the per-skill reliability table, and a one-line
summary that repeats the profile and privileged share so a number quoted out of
context still carries them. `offline.ts` provides `OfflineWorldView`,
`offlineActuators` and `OfflineInvoker` for when no body is bound; reads report
that they are unavailable rather than inventing a body at the origin with full
health.

The protocol version actually spoken is the one `@modelcontextprotocol/sdk`
1.30.0 implements. That SDK's `LATEST_PROTOCOL_VERSION` is `2025-11-25` and it
negotiates down through `2025-06-18`, `2025-03-26`, `2024-11-05` and
`2024-10-07`. `TARGET_PROTOCOL_VERSION` in `src/mcp/server.ts` records
`2025-11-25` so a run manifest can say what wire format produced it. Later spec
additions are deliberately unused, because hand-rolling wire shapes against an
SDK that cannot parse them would produce a server that looks current and
interoperates with nothing.

MCP has two error channels and this codebase treats them as different things. A
JSON-RPC protocol error says the request itself was wrong, and a model can
rarely recover from one. A tool execution error is an ordinary result carrying
`isError: true`, which clients are expected to feed back to the model. Every
`FailureKind` maps onto the second: `failureResult` in `src/mcp/tools.ts`
returns `{ ok: false, skill, kind, retryable, message, durationMs }` as
`structuredContent` with `isError` set. Only two things raise `McpError`: a
`tools/call` for a name that is not registered, and a `resources/read` for a URI
this server does not have. Those are cases where the agent asked for something
that does not exist. A precondition that did not hold, a target that could not
be reached and a budget that ran out all happened in the world, and an agent
told about them can do something next.

The server also has no session concept, because MCP has none at the protocol
level. An open container is reported as an observation on
`craftonomous://surroundings`, not as a state the agent is inside.

One gap worth stating: nothing enforces a call budget. `ToolDispatcher.call` is
the single path from an agent to an actuator and is where rate limiting would
go, but a looping or hostile client can currently invoke as fast as the body
responds.

### Planning

`src/planning/` is pure offline algorithm with no mineflayer, no network and no
model SDK. Where a model would be used it arrives as an injected function.
`dag.ts` is a task graph with cycle detection, `decomposer.ts` expands a goal
into subtasks, `rules.ts` is a rule miner in the WALL-E shape (propose, refine,
prune) that learns action preconditions from failed attempts, and
`knowledge-graph.ts` is a correctable world model with per-edge sources.

### The reference agent

`src/agent/` is a client of the same surface anyone else gets. `loop.ts` is the
observe, decide, act, record cycle with a step budget, an abort signal and a
full trace. `observation-digest.ts` renders a `WorldView` into text an LLM can
read, tagging each fact with its provenance and age. `memory.ts` keeps turns,
facts and named locations. `goal.ts` is a depth-limited goal stack.
`policy.ts` provides `RulePolicy` and `ScriptedPolicy`, and `llm.ts` provides
`LlmPolicy` over an injected `LanguageModel` function.

## Evaluation

There are two pieces here, and they are not yet joined to each other.

The offline symbolic sandbox in `src/sandbox/` is built and runs with no
server, no Java and no network, in the spirit of plancraft. `recipes.ts`
derives crafting rules from `minecraft-data` pinned at
`DEFAULT_MINECRAFT_VERSION = '1.21.1'` and carries a hand-written smelting
table because `minecraft-data` does not ship one. `techtree.ts` produces a
crafting plan and names the missing materials when it cannot. `world.ts` is a
symbolic world whose actions can be refused with a stated reason. `task.ts`
defines `STARTER_TASKS`, and `runner.ts` runs a `Policy` (a plain function from
world and step to action) under a step budget. `planningPolicy` is a baseline
that replans from the current inventory every step, so there is a floor without
an agent attached.

`src/eval/` is the scoring and reporting harness, agent-agnostic by
construction. `task.ts` gives every task a version, every suite a version and
every manifest a truncated SHA-256 content hash, so a result can name the exact
task set it was earned on. `scoring.ts` scores deterministically with no model
in the loop, and `isCredited` inverts the polarity on tasks flagged
`impossible`, where refusing earns credit and a reported success is recorded as
a false claim. `runner.ts` owns repeats, per-attempt seeds derived by FNV-1a
from (manifest hash, task id, repeat, base seed), and time and step budgets
enforced by the harness rather than trusted to the agent, so a hang produces a
`timeout` row rather than a missing one. `report.ts` will not emit a score
without the perception profile and privileged share beside it. `suites/` holds
`GATHERING_SUITE` (9 tasks) and `REFUSAL_SUITE` (8 tasks, 5 of them
impossible), which are data: their `goal` fields are English sentences for a
human reader, and nothing parses them.

No live scenario runner exists, and it is worth being plain about how far that
goes.

Nothing in `src/` implements a `TaskExecutor`. The only implementations
anywhere are inline stubs in `tests/eval/`. `src/eval/` imports nothing from
`src/sandbox/`, `src/embodiment/`, `src/skills/`, `src/mcp/` or `src/agent/`,
and nothing in `src/` imports `src/eval/`, so even the offline sandbox is not
currently wired into the scoring harness: `src/sandbox/runner.ts` has its own
`Policy` and `Action` types over `SymbolicWorld` that are never bridged to
`TaskExecutor`.

There is also no server to run against. The repository contains no
docker-compose file, no server jar, no `server.properties` and no pinned server
image, and the CI workflow only typechecks, lints, tests and builds. The
`CRAFTONOMOUS_BOOTSTRAP` module that `src/cli/main.ts` dynamically imports to
bind a live body (`DEFAULT_BOOTSTRAP` points at `../runtime/bootstrap.js`) is
not part of this repository, so the shipped CLI always takes the offline branch
and says `mode: OFFLINE` on stderr. `src/embodiment/mineflayer/binding.ts` does
contain real `mineflayer.createBot` code, but nothing in `src/` assembles it
into a `Session`.

A live tier against a pinned modern server, in the spirit of PillagerBench, is
on the [roadmap](ROADMAP.md) and is not built.

No VLM judge in the core metric, and none is planned. MCU and MineAnyBuild both
score with one, which makes their results a function of a model that will be
deprecated.

## Conventions

Time comes from an injected `Clock` (`src/runtime/clock.ts`). Nothing calls
`Date.now()` directly, so memory decay, staleness, skill timeouts and eval
timing all replay deterministically, and `ManualClock` makes them testable.

Failure is returned as data where a caller can act on it, and thrown where
continuing would produce a misleading measurement. `PerceptionDenied` throws;
a skill failure does not.

Absence means "not known", never "not there". Every `WorldView` method that can
return `undefined` means the first, and the `surroundings` resource names its
block list `knownBlocks` so an agent cannot read it as the blocks that are
there.

`reference_repos/` is outside version control, the build and the test runner.
It is read as prior art and cited, never vendored.
