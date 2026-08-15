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
│    token-bucket call budget                 │
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

The boxes are wired together in exactly one place, `src/runtime/bootstrap.ts`.
Every other module is built and tested against a contract rather than against
its neighbours, which is what keeps the whole stack runnable over the in-memory
fake body. See [assembly](#assembly) below.

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
`equipment`, `isOccluded` and `findBlocks` answer without regard to any profile,
and the two optional drains, `drainSounds` and `drainChat`, do the same for
events. Only `PerceptionAdapter` in `src/perception/adapter.ts` may hold one.
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
and `MineflayerEmbodiment` with a `connect` helper that retries the first join
under an exponential backoff, `lifecycle.ts` holds `JoinBudget` and
`SessionSupervisor` for what happens to a session after it is up (death,
respawn, a dropped socket), `auth-errors.ts` turns XSTS failures into messages
that say what to do, and `taxonomy.ts` classifies entities by name. The join
budget is capped one under Mojang's six joins per thirty seconds, and initial
joins and reconnects draw on the same budget because the server counts them the
same way. `SessionSupervisor` is not wired into `connect()`; see the end of the
evaluation section for why.

`src/embodiment/fake/` is an in-memory world used by the tests, which is what
lets the perception and skill layers be tested with no server, no Java and no
network, and what `createOfflineSession` assembles over.

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

The `WorldView` surface in `src/perception/world-view.ts` is `profile`, `body`,
`inventory`, `blockAt`, `nearbyEntities`, `findBlocks`, `openContainer`,
`recollections`, `sounds`, `testimony`, `checkPositionClaim` and `report`. The
last three arrived with hearing and testimony and are described next.

### Hearing and testimony

`SensorPort` gained two optional methods, `drainSounds` and `drainChat`. Both
drain rather than read: a sound is an event, and a getter that kept answering
with the last one would let a caller act twice on one footstep and would count a
hearing read every time. Both are optional so that a substrate which cannot
report sound simply does not implement them, and callers read the empty result
as silence rather than as "nothing was audible".

`PerceptionAdapter.sounds()` turns each drained `SoundEvent` into a `HeardSound`
and puts it through `PerceptionGate.sound`, which drops anything beyond the
profile's `hearingRange` before it is recorded, so a sound the agent could not
hear is not counted in the ledger either. A `HeardSound` carries a name, a
bearing rounded to eight compass points, an elevation of above, level or below,
a distance band with its bounds, and a volume. It deliberately carries no
position. The adapter knows the source coordinate and refuses to pass it on,
because handing over an exact coordinate would be sight wearing hearing's label.

`PerceptionAdapter.testimony()` wraps each drained `ChatMessage` as an
unverified `Testimony` from `src/perception/testimony.ts` and tags it with
provenance `testimony`. Every message is admitted, because hearing somebody
speak is not the same as believing them, and a claim the agent refused to
receive cannot be weighed later.

`TestimonyRegister` in the same file records where the agent has itself seen
each speaker, fed only from sightings that already passed the gate, so it can
never be a route around the profile. `checkPositionClaim` answers one modest
question: was that speaker ever seen close enough to a claimed position to have
sensed it? The three statuses are `unverified`, `speaker-could-have-known` and
`no-sighting-supports-it`, and there is no `true` among them. Testimony
establishes opportunity, never truth: a player standing on a diamond vein can
still lie about it, and a speaker the agent never saw nearby is the entirely
ordinary case of somebody who walked somewhere while the agent was underground.
No status ever promotes the observation's provenance out of `testimony`, which
is exactly the laundering the provenance tags exist to prevent.

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

`src/skills/reflex/` is the layer that can pre-empt a running skill. `types.ts`
requires `shouldFire` to be synchronous and side-effect free, because a reflex
that reasons is not a reflex. `builtin.ts` ships responses to lava, drowning,
fire, falling, low health and starvation, and `REFLEX_PRIORITY` orders them by
how fast the situation kills you. `arbiter.ts` picks the winner and is pure: it
answers "what would fire here?" and nothing more. The thing that asks it on a
schedule is `ReflexSupervisor` in `src/runtime/supervisor.ts`, described under
[assembly](#assembly). Until that existed the reflexes were unreachable code.

`src/skills/reliability.ts` tracks per-skill attempts and successes and ranks on
a Wilson score lower bound at 95% confidence rather than the naive rate, because
the naive rate is maximally wrong exactly when there is least evidence. The
default retirement policy retires a skill after at least 8 attempts once
confidence falls below 0.25. More in [skill reliability](SKILL_RELIABILITY.md).

`src/skills/library/` holds eighteen core skills, listed in `CORE_SKILLS`:
`goToPosition`, `goToBlock`, `goToEntity`, `lookAt`, `flee`, `explore`,
`digBlock`, `collectBlock`, `placeBlock`, `craftItem`, `smeltItem`, `equipItem`,
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

| Kind            | Meaning                                                   | Retryable |
| --------------- | --------------------------------------------------------- | --------- |
| `timeout`       | Ran past its time budget.                                 | yes       |
| `unreachable`   | The target could not be reached.                          | yes       |
| `world-changed` | The target block or entity is gone.                       | yes       |
| `rate-limited`  | Refused by a rate limiter before the skill ran.           | yes       |
| `precondition`  | A stated precondition did not hold when checked.          | no        |
| `interrupted`   | Pre-empted by a reflex or an explicit cancellation.       | no        |
| `invalid-input` | Input failed schema validation.                           | no        |
| `not-permitted` | The perception profile forbade a read the skill required. | no        |
| `unknown`       | Everything else. Expected to shrink over time.            | no        |

That is the whole of `FailureKind`, and the four kinds marked retryable are
exactly the contents of `RETRYABLE_FAILURES`.

Collapsing all of these into a boolean throws away the only information that
would tell an agent what to do next. Retrying is right for a timeout and wrong
for a precondition. A precondition failure means re-plan, because the world is
not in the state the plan assumed. `rate-limited` is the most retryable of all,
because the only thing that has to change is the clock, and it is kept separate
from `timeout` because nothing was attempted: the agent should wait rather than
change its plan. `not-permitted` means neither: the agent did not fail at the
task, it was not allowed to look, and the fix is a different approach or a
different profile rather than another attempt. `invalid-input`
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

### Rate limiting

`src/mcp/rate-limit.ts` enforces a call budget, and `ToolDispatcher.call`
applies it in the one place every agent-driven actuation passes through. The
check happens after the tool name is resolved and before anything is validated
or run: ahead of the name check a typo would burn budget the agent could not
have known it was spending, and behind the invoker the packets the limiter is
trying not to send would already be gone. `createServer` in `src/mcp/server.ts`
supplies a limiter by default and shares its clock; a `ToolDispatcher`
constructed directly in a test gets none. Switching it off is spelled `'off'`
rather than being what omission gives you, because a limiter that can be
disabled by accident is one that will be.

The algorithm is a token bucket rather than a fixed window, since a fixed window
lets a client spend a full allowance at the end of one window and again at the
start of the next. Two budgets apply and a call needs room in both: a global one
across every tool, defaulting to 30 calls per minute, and a per-tool one,
defaulting to 10 per minute, so one skill hammered in a loop cannot drain the
global bucket and starve the rest of the body. The numbers are set against what
is downstream rather than against this process. An allowed call becomes packets
on a Minecraft connection, and a server disconnects a client that floods it;
worse, the Mojang session endpoints are limited per account rather than per
process, and a penalty there outlives the run and belongs to a person.

A refusal comes back as a tool execution result carrying the `rate-limited`
failure kind, `retryable: true` and a `retryAfterMs`, never as an `McpError`.
Being told to slow down is precisely the kind of thing a model can correct on
its own, and raised as a JSON-RPC error it would look like a transport fault
that most clients either retry blindly or tear the session down over.
`describeRefusal` names a time, because a model told only that it was rate
limited retries immediately and makes things worse.

A refused call deliberately does not consume budget, from either bucket. It
never reached the server, so there is nothing downstream to charge it against,
and, more importantly, charging for refusals would make every `retryAfterMs`
quoted a lie that gets worse each time it is believed: an agent retrying a
moment early would push its own deadline out, and a client polling faster than
the refill rate could never recover. The price of that choice is that a hot
loop can be refused for free forever, which costs a map lookup and some
arithmetic, and this process is not the resource being protected.

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

### Assembly

`src/runtime/session.ts`, `src/runtime/bootstrap.ts` and
`src/runtime/supervisor.ts` are the layer that puts the other layers together.
Everything else in `src/` is built against a contract; this is the one place
that constructs neighbours.

`Session` in `session.ts` is what a bootstrap returns: a `SkillRegistry`, a
`SkillInvoker`, a `WorldView`, a `ReliabilityTracker`, an `ActuatorPort`, the
`PerceptionGate` the observations passed through, the `Clock` the whole stack
shares, an optional `ReflexSupervisor` and an optional `close`. There is no
`SensorPort` on it and there never will be. The bootstrap touches a port because
it is doing the wiring; nothing it hands back exposes one.

`bootstrap.ts` has a private `assemble` that builds the stack over whatever
`EmbodimentPort` it is handed: gate, `WorldMemory` expiring against the gate,
a `ContainerTrackingActuators` wrapper that remembers what `openContainer`
returned so the adapter has a container to report, a `PerceptionAdapter` over
the sensors, a registry loaded with `CORE_SKILLS`, a `ReliabilityTracker`, a
`SkillRunner`, a `ReflexArbiter` over the built-in reflexes, a
`ReflexSupervisor` started on an interval, and a `SupervisedInvoker` that puts
every run under that supervisor. `createSession` is the live path: it resolves
the perception profile by name, dynamically imports the mineflayer binding, and
assembles over the connected body. `createOfflineSession` is the identical
assembly over `src/embodiment/fake/`, differing only in which `EmbodimentPort`
goes in. That is what makes the wiring testable with no server, no Java and no
network, and it is also a real way to drive the MCP surface: every tool call
runs, moves a body and shows up in the perception ledger.

`src/cli/main.ts` reaches this layer by specifier rather than by import:
`CRAFTONOMOUS_BOOTSTRAP`, defaulting to `DEFAULT_BOOTSTRAP` which is
`../runtime/bootstrap.js`. That module is now part of this repository, so the
live branch is reachable and the CLI prints `mode: LIVE` when `createSession`
returns a session. A failed load is not a crash: `loadSession` returns the
reason, the CLI prints `mode: OFFLINE` with exactly what was missing, and the
MCP surface still starts over `OfflineWorldView`, where every world read reports
that it is unavailable rather than guessing. Loading by specifier is also what
keeps the MCP surface compiling and testable with no mineflayer present.

`SupervisedInvoker` does not trust the caller's context for `world` and `act`.
A caller cannot know this session's ports (the MCP layer builds a context with
refusing offline actuators, because it is given no others), and a run against a
world nobody wired is worse than no run at all. It takes `log` and `signal` from
the caller and supplies the rest itself.

`ReflexSupervisor` in `supervisor.ts` is the only thing that ticks the arbiter.
Two rules shape it. Aborting is synchronous, because a skill that keeps digging
for one more tick while the body drowns is the failure the class exists to
prevent. Acting is not, because a reflex moves a body and that takes time.
Between the two no second reflex may start, since a body cannot climb out of
lava and flee a skeleton at once. `guard(controller)` puts a run under
protection and returns a release function; when a reflex fires, every guarded
controller is aborted. `SupervisedInvoker` registers its controller
synchronously, before its first `await`, so a reflex that fires during the run
reaches a controller that is already registered. The abort arrives at the skill
through the signal the runner folded together, and `SkillRunner` reports a
caller-side abort as `interrupted`, so a pre-empted skill settles as
`interrupted` rather than as `timeout`. `tick()` survives a throwing evaluation
by logging it, because a supervisor that dies on one bad tick takes every later
reflex with it, and `settle()` waits out an action in flight. The interval timer
is unref'd, so the reflex loop is never the reason a process refuses to exit.

The assembly is also where a reconnect is acted on. `AssembleOptions.lifecycle`
takes anything that reports a `reconnected` event, and on one the world memory
is cleared and the count logged. Forgetting is the honest response: entity ids
are reassigned by the server, the world moved on while the socket was down, and
every remembered fact is older than its timestamp claims. Nothing produces that
event on the live path today; see the end of the evaluation section.

### Persistence

`src/persistence/` keeps the two things whose loss makes a long run
indistinguishable from a cold start: what the agent has seen, and how well its
skills have actually worked. Without it every reliability judgement is discarded
when the process ends.

`snapshot.ts` defines the on-disk shape and a decoder that refuses to guess.
`SCHEMA_VERSION` is 2 and `MIN_SUPPORTED_SCHEMA_VERSION` is 1: version 1 held
world memory only, version 2 adds reliability evidence, and a version 1 file
still loads with no recorded evidence, which is honest, because it never had
any. The decoder is tolerant in one direction only. Unknown extra fields are
ignored and an absent section reads as empty, so a slightly older and a slightly
newer file both load, and everything else, including an unknown version or a
field of the wrong type, raises `SnapshotFormatError` or `SnapshotVersionError`
from `errors.ts`.

Each `ObservationRecord` carries its `sensedAt` and it is persisted and restored
verbatim. A restore that re-stamped it with the current time would turn
hours-old belief into a present-tense sighting, which is the exact fabrication
the provenance layer exists to prevent. `memory-codec.ts` and
`reliability-codec.ts` do the conversions, and `capture.ts` is the pair of calls
a run actually makes: `captureSnapshot` takes a `WorldMemory` and a
`ReliabilityTracker` with a `savedAt` read from a `Clock`, and `applySnapshot`
puts them back, adding to rather than clearing the targets so that a pure
restore is a matter of handing in fresh instances and merging two runs is a
deliberate act.

`file-store.ts` writes atomically. The payload goes to a uniquely named
temporary file in the same directory as the target, is flushed to the device
with `handle.sync()`, and only then replaces the target by rename. The same
directory matters, because rename is atomic only within a filesystem and a
temporary file elsewhere degrades into a copy. The flush matters because a
rename landing while the contents sit in the page cache yields, on power loss,
an entry pointing at an empty file, which is the corruption the temporary file
was there to prevent. On Windows the destination can be transiently locked by a
scanner or an indexer, surfacing as `EPERM` or `EBUSY`, so those are retried
with a short backoff rather than reported as corruption, and a save that fails
every attempt removes its temporary file and leaves the previous good snapshot
in place. `load` returns `undefined` for a missing file, because a first run has
no snapshot and that is the normal case rather than a fault.

## Evaluation

The offline symbolic sandbox in `src/sandbox/` is built and runs with no
server, no Java and no network, in the spirit of plancraft. `recipes.ts`
derives crafting rules from `minecraft-data` pinned at
`DEFAULT_MINECRAFT_VERSION = '1.21.1'` and carries a hand-written smelting
table because `minecraft-data` does not ship one. `techtree.ts` produces a
crafting plan and names the missing materials when it cannot. `world.ts` is a
symbolic world whose actions can be refused with a stated reason,
`inventory.ts` is its item-count store, `task.ts`
defines `SymbolicTask`, `defineTask` and `STARTER_TASKS`, and `runner.ts` runs a
`Policy` (a plain function from
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
impossible). Their `goal` fields are still English sentences for a human reader,
but they are no longer what gets checked; see below.

### Goal predicates

`src/eval/goal-check.ts` is what turns a goal into something checkable. A
`GoalPredicate` has five shapes, each required by a shipped task:
`item-count`, `item-tag-count`, `block-nearby`, `agent-y-at-least` and
`enclosed`.

Every shipped task carries an authored `goalPredicate` field, and `predicateFor`
resolves in a fixed order: a caller-supplied override keyed by task id wins,
then the task's authored predicate, and parsing the prose is only the fallback.
That order is the point. A task's `goal` is documented as prose for a human
reader, and if parsing it were the mechanism then rewording a sentence for
clarity would silently change what was being measured, or leave a suite whose
goals no longer parse reporting every attempt as unscorable. Third-party suites
that supply only prose still work, which is why `parseGoal` remains, strict and
refusing anything it does not recognise rather than guessing.

Two rules govern the checking. `checkPredicate` reads the world only through a
`WorldView`, so goal checking is subject to the same sight range, occlusion and
ledger accounting as the agent under test; a checker that reached past the gate
would measure the harness's eyesight. And an unparseable or uncheckable goal is
never "not met": it returns `checkable: false` and callers turn that into an
`error` outcome rather than a `failure`. The `enclosed` predicate is honest
about being weaker than the sentence it answers, reporting a caveat that only
the six face neighbours were tested because `WorldView` exposes no sky-light
query. `checkPredicateAgainstItems` answers the two inventory predicates from a
plain item-count map, for tiers that have no `WorldView` at all.

### The two executors

`TaskExecutor` now has two implementations in `src/`, and neither is a stub.

`src/eval/sandbox-executor.ts` is the offline tier and the more useful of the
two today, because it needs no server, no Java and no network, so a suite score
can be produced on every commit. `createSandboxExecutor` bridges the harness to
the symbolic sandbox: it resolves the predicate, turns it into a `TaskGoal` and
a `SymbolicTask` through `defineTask` in `src/sandbox/task.ts` over a
caller-supplied `SandboxScenario`, and then calls `runTask` from
`src/sandbox/runner.ts` rather than reimplementing the stepping loop. The predicate, not the sandbox's own inventory test, decides whether the
goal was met, with item names normalised on both sides because the suites are
namespaced and the sandbox is not. Outcome mapping is deliberately identical to
the live tier, including the refusal test, so a task scored offline and the same
task scored against a server mean the same thing by `refused`.

Two things it will not do. The sandbox has no positions, no altitude and no
placement, so the crafting table placement goal, the shelter goal and the
altitude goal return `error` with a reason rather than `failure`: an agent never
given a world in which the goal is expressible has not failed. And a `Task`
carries no starting world, so a scenario per task is a capability the caller
supplies; a task with no scenario is an `error` rather than a quiet run against
an empty plain.

`src/eval/live.ts` is the live tier. `createLiveExecutor` takes a `LiveSession`
(world, invoker, clock, optional skill catalogue, optional close), pushes the
task's goal onto an `AgentLoop` in the suite's own words, runs it under the
task's step budget and abort signal, checks the goal through the same
`WorldView` the agent used, and maps what happened onto a `TaskOutcome`. It
refuses by default to run a task under a perception profile other than the one
the task declares, because a result earned under the wrong profile is a
different result. Both executors are `RecordingExecutor`s: they keep a live
array of per-attempt records, and the live one attaches the `PerceptionReport`
to each, so a score never travels without the statement of how it was come by.

`LiveSession` is declared structurally in `live.ts` rather than imported from
`src/runtime/session.ts`, so the harness stays usable against a substrate that
is not this repository's. A full `Session` satisfies it without knowing the
interface exists.

Two capabilities the live executor refuses to fake. It does not spawn a session:
`deps.session` is supplied by the caller, because a module that quietly
connected to `localhost` during a test run would be worse than one that refuses.
And it does not reset the world. A proper benchmark attempt starts from a known
chunk, a known biome and an empty inventory, none of which is reachable from
inside the process: a `WorldView` is read-only and the skill surface cannot
teleport a bot or roll a world back. The reset is `deps.prepare`, and without it
every attempt records `preparedBy: 'nothing'` and says so in its detail text,
because an attempt that inherited the previous one's inventory is a different
measurement and the score must not conflate the two.

Both executors share the refusal vocabulary in `live.ts`. The refusal suite
turns on telling an agent that stopped because bedrock has no drop from one that
stopped because it got bored, and both arrive as a decision with a sentence
attached, so `REFUSAL_PATTERNS` is about impossibility rather than difficulty
and a policy can be unambiguous by beginning its reason with `impossible:`.

### The live harness

`docker/docker-compose.yml` brings up a pinned, disposable server:
`itzg/minecraft-server` at an exact release tag with its digest recorded,
Minecraft 1.21.4 vanilla, offline mode, a fixed seed, peaceful difficulty, no
whitelist, zero spawn protection, RCON off, and an `mc-health` healthcheck so a
script can wait on a fact instead of sleeping. Offline mode is the load-bearing
choice: the bot joins with `auth: offline` and a made-up username, so no real
account and no Mojang session join is involved. `npm run mc:up`, `mc:down`,
`mc:reset` and `mc:logs` drive it, and `mc:reset` throws the world away so the
next start regenerates it from the seed.

`scripts/smoke.mjs` is the first thing to run against a real server. It is plain
ESM against the built binding in `dist/`, and it exercises the parts no unit
test can reach in the order they break: connection, spawn, body state, block
reads, occlusion, one real movement, clean disconnect. Every wait is
time-bounded, it prints one line per check, and it refuses outright to run with
`MINECRAFT_AUTH=microsoft`, making exactly one join attempt and never retrying.

`tests/live/` holds the live suite, kept out of the ordinary run by two
independent mechanisms: the files are named `*.live-test.ts` so the root vitest
config never collects them, and each suite is skipped unless
`CRAFTONOMOUS_LIVE=1`. `tests/live/vitest.config.ts` runs them single-forked
with no file parallelism, because parallel files mean parallel joins.
`tests/live/embodiment.live-test.ts` connects once in a `beforeAll` and reuses
that connection, and refuses any auth mode other than offline. The reason for
all of this is written down in `docs/LIVE_TESTING.md`: Mojang allows six session
joins per thirty seconds per account, and a suite that joins per test is the
pattern that costs somebody an account the day it is pointed at a real one.

### What is still not true

Reconnection is written but inactive. `SessionSupervisor` in
`src/embodiment/mineflayer/lifecycle.ts` exists, handles death, respawn and
rejoin against a shared `JoinBudget`, and emits `reconnected` with a generation
number, and `assemble` in `src/runtime/bootstrap.ts` is ready to clear world
memory when it hears one. But `connect()` deliberately does not construct a
`SessionSupervisor`, because `MineflayerSensorPort` and `MineflayerActuatorPort`
hold the bot they were constructed with and cannot rebind to a replacement. A
supervisor that swapped its bot would leave those ports talking to a dead socket
while appearing to have recovered, which is worse than not reconnecting at all.
Rebinding the ports is the prerequisite, and it has not been done.

No run against a live server has happened. The compose file, the smoke script
and the live suite are written and none of them has been executed against a
server, so nothing here is a report of observed behaviour on a real world. The
live tier in the spirit of PillagerBench remains on the [roadmap](ROADMAP.md).

No VLM judge in the core metric, and none is planned. MCU and MineAnyBuild both
score with one, which makes their results a function of a model that will be
deprecated.

## Conventions

Time comes from an injected `Clock` (`src/runtime/clock.ts`), so memory decay,
staleness, skill timeouts, rate limit buckets, snapshot stamps and eval timing
all replay deterministically, and `ManualClock` makes them testable. One place
in `src/` reads the wall clock without a `Clock`: `SessionSupervisor` in
`src/embodiment/mineflayer/lifecycle.ts` defaults its `now` to `Date.now()`,
takes an injected one, and is given an injected one by its tests.

Failure is returned as data where a caller can act on it, and thrown where
continuing would produce a misleading measurement. `PerceptionDenied` throws;
a skill failure does not.

Absence means "not known", never "not there". Every `WorldView` method that can
return `undefined` means the first, and the `surroundings` resource names its
block list `knownBlocks` so an agent cannot read it as the blocks that are
there.

`reference_repos/` is outside version control, the build and the test runner.
It is read as prior art and cited, never vendored.
