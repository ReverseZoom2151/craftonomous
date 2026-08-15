# Architecture

## Shape

```text
┌─────────────────────────────────────────────┐
│  any agent  (Claude Code, Codex, LangGraph, │
│              a local Ollama loop, a human)  │
└───────────────────┬─────────────────────────┘
                    │  Model Context Protocol
┌───────────────────▼─────────────────────────┐
│  MCP surface                                │
│    tools: skills          resources: state  │
└───────────────────┬─────────────────────────┘
┌───────────────────▼─────────────────────────┐
│  skill layer                                │
│    schema · timeout · interrupt · reliability│
└───────────────────┬─────────────────────────┘
┌───────────────────▼─────────────────────────┐
│  perception gate      ◄── profile           │
│    provenance tagging ──► ledger            │
└───────────────────┬─────────────────────────┘
┌───────────────────▼─────────────────────────┐
│  embodiment  (mineflayer)                   │
└───────────────────┬─────────────────────────┘
                    │  Minecraft protocol
              ┌─────▼──────┐
              │   server   │
              └────────────┘
```

The load-bearing constraint: **nothing above the perception gate may reach past
it.** Skills do not hold a reference to the bot. If they did, the ledger would
be fiction and the profile unenforceable.

## Why the agent sits outside

Five projects in the [survey](PRIOR_ART.md) independently started pulling agent
reasoning out of the Minecraft integration — haksnbot, clawcraft,
gemini-minecraft, justjavac's minecraft-agent, and plancraft. None finished.
The pattern keeps recurring because the coupling is genuinely wrong: a bot
framework that owns its own LLM loop can only ever be evaluated as a whole, and
its skill library cannot be reused by anyone whose agent works differently.

Craftonomous owns the body and refuses to own the brain. A reference agent
ships to prove the substrate works, but it is a client of the same MCP surface
everyone else uses, with no privileged in-process access.

## Layers

### Embodiment

mineflayer, chosen over MineRL/Malmo for reasons recorded in the
[survey](PRIOR_ART.md): it tracks current Minecraft versions (1.8 through
1.21.11), needs no JDK, and is MIT with no NonCommercial ancestry. The MineRL
family is pinned to Minecraft 1.16.5 and JDK 8, and minerl itself is
CC BY-NC-SA.

### Perception gate

Described in [perception](PERCEPTION.md). Every observation is tagged with its
provenance, checked against the run's profile, and counted.

### Skill layer

A skill is a named, schema-validated operation with a declared precondition and
a structured result. Around every invocation sits:

- a **timeout**, so a wedged skill cannot stall a run
- an **interrupt**, so a reflex can pre-empt a long action
- **reliability accounting**, described in [skill reliability](SKILL_RELIABILITY.md)

Two ideas here are taken from prior art, reimplemented rather than copied.
mindcraft wraps every skill call with timeout, interrupt and loop detection, and
keeps a layer of always-ticking reflexes that can override the planner — the
right answer, since drowning should not require an LLM round-trip.
minecraft-agent-swarm tracks per-skill success rates and retires skills that
stop working, which is the feedback loop the Voyager lineage never closed.

Because this project is clean-room, the skill library is built narrow and deep
rather than broad. Odyssey publishes 205 mineflayer skills under MIT; we do not
port them. A small set of skills with measured reliability is worth more here
than a large set with none, and it is the honest thing to promise.

### MCP surface

Skills become MCP tools. World state becomes MCP resources. The run manifest —
outcome, perception report, reliability table — is emitted as structured output.

### Evaluation

Two tiers, mirroring what the survey found works:

- **Offline symbolic**, in the spirit of plancraft: crafting and planning tasks
  with no server at all, fast enough for CI, deterministic enough to regress on.
- **Live scenarios** against a pinned modern server, in the spirit of
  PillagerBench: continuous scoring read from real game state.

No VLM judge in the core metric. MCU and MineAnyBuild both score with one, which
makes their results a function of a model that will be deprecated.

## Conventions

- Time comes from an injected `Clock`. Nothing calls `Date.now()` directly, so
  memory decay, staleness and timing replay deterministically.
- Failure is returned as data where a caller can act on it, and thrown where
  continuing would produce a misleading measurement.
- `reference_repos/` is outside version control, the build, and the test runner.
  It is read as prior art and cited, never vendored.
