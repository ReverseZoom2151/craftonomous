<h1 align="center">Craftonomous</h1>

<p align="center"><strong>Agent-Agnostic Minecraft Embodiment and Evaluation Substrate</strong></p>

A test-driven substrate for putting agents into Minecraft and measuring them
honestly. Craftonomous is not another bot. It is the body, the senses, the
skill library and the scoreboard that a bot plugs into, exposed over the
[Model Context Protocol](https://modelcontextprotocol.io) so that any agent can
drive it.

It is not a finished platform. This repository contains no trained weights, no
published benchmark results, and no claimed task success rates. Nothing here
has yet been run end to end against a live Minecraft server.

The design follows a survey of 52 open-source Minecraft-agent repositories (see
[prior art](docs/PRIOR_ART.md)). Three findings shaped it. Five separate
projects independently began decoupling Minecraft control from agent reasoning
and none finished. Published benchmarks are largely unreproducible, and one
states in its own README that its published baselines were invalidated by a
bug. And almost every agent reads world state directly out of the game client,
so no published comparison distinguishes an agent that explored a cave from one
that read through the wall.

## What is implemented

- **Provenance-tagged observation.** Every fact an agent receives carries how it
  was obtained: proprioception, sight, hearing, memory, inference, testimony, or
  privileged. Provenance combines pessimistically, so anything derived from a
  privileged read stays privileged and the taint cannot be laundered.
- **An enforced perception budget.** Three profiles (`fair-play`, `xray`,
  `omniscient`) govern sight range, line-of-sight occlusion, hearing range, and
  a memory horizon past which facts are forgotten. Occlusion is computed by
  Amanatides and Woo voxel traversal, not asserted by the caller.
- **A perception ledger.** Every read is counted by provenance, and a run
  reports its privileged share and a fair-play verdict. The cost of cheating
  becomes a number in the results table instead of an assumption.
- **A mineflayer binding.** Java Edition over the wire, with reconnection
  backoff floored at Mojang's six-joins-per-thirty-seconds limit, and the five
  XSTS failure codes mapped to guidance a user can act on.
- **An offline fake world.** Deterministic voxel world and actuators that really
  mutate, so skills are testable end to end with no server, no Java and no
  network.
- **Seventeen skills.** `goToPosition`, `goToBlock`, `goToEntity`, `lookAt`,
  `flee`, `digBlock`, `collectBlock`, `placeBlock`, `craftItem`, `smeltItem`,
  `equipItem`, `consumeItem`, `dropItem`, `depositItems`, `withdrawItems`,
  `attackEntity`, `sendChat`. Each reads back through the perception layer
  rather than trusting the actuator.
- **A runner and a reflex layer.** Every invocation is wrapped in a timeout,
  an interrupt, repetition detection and reliability accounting. Reflexes for
  lava, drowning, fire, falling, low health and starvation sit below the
  planner and pre-empt it, because drowning should not require a model
  round-trip.
- **Reliability measured with a Wilson lower bound.** A skill that succeeded
  once scores about 0.21 rather than 1.0, so ranking and retirement gate on
  evidence instead of luck.
- **An MCP server.** Skills become tools, and five resources expose state:
  `craftonomous://body`, `://inventory`, `://surroundings`, `://perception`,
  `://skills`. Skill failures cross as tool execution errors carrying their
  failure kind and retryable flag, which is what lets a model self-correct.
- **A deterministic evaluation harness.** Versioned, content-hashed task
  manifests and no model-based judging anywhere in the core metric. A score is
  never printed without the perception profile and privileged share it was
  earned under. Two suites ship: `gathering` (9 tasks) and `refusal` (8 tasks,
  five of them impossible by game rule).
- **An offline symbolic sandbox.** Crafting derived from `minecraft-data` at
  version 1.21.1, cycle-guarded tech-tree planning, and a symbolic world for
  CI-speed regression.
- **A reference agent.** A client of the same MCP surface everyone else uses,
  with no privileged access. Its prompt digest renders a remembered block as
  remembered with its age, never as a present fact.
- **A research layer.** Task DAG with atomic splice and bounded lookahead,
  rule mining from an agent's own failures, and an experience-corrected
  knowledge graph in which a wrong prior is genuinely unlearned.

743 tests across 45 files, all offline. Typecheck, lint and build are clean.

## What still requires execution

No run against a live Minecraft server has happened yet. The mineflayer binding
typechecks and its offline-testable parts are covered, but the end-to-end path
of connect, sense, act, score has not been exercised against a real world. Until
it is, there are no baselines and no results worth quoting.

Known gaps, tracked in the [roadmap](docs/ROADMAP.md):

- The fake actuator teleports rather than pathfinds, so it will not catch a
  skill that assumes it can walk somewhere unreachable.
- Reliability has no recency weighting and no per-context conditioning, so a
  skill broken by yesterday's server update is still buoyed by last month.
- Testimony is unverified. A lying agent is currently believed.
- Nothing rate-limits tool invocation at the MCP boundary.
- There is no `explore` skill, so the rule policy cannot recover when nothing
  of its target is in sight.

## Scope

Java Edition only. Craftonomous speaks the Minecraft Java protocol through
mineflayer, which supports 1.8 through 1.21.11 and needs no JDK. Bedrock add-on
scripting and the Persona API are a different architecture entirely and are out
of scope.

Craftonomous is clean-room. The surveyed repositories are read as prior art and
cited; no code is copied from them. That corpus is excluded from version
control, the build, and the test runner.

## Install

```bash
git clone https://github.com/ReverseZoom2151/craftonomous.git
cd craftonomous

npm install
npm test
```

Node 22 or newer. A Minecraft server is needed only for live play. The whole
test suite runs offline.

## Use it as an MCP server

```json
{
  "mcpServers": {
    "craftonomous": {
      "command": "npx",
      "args": ["craftonomous"],
      "env": {
        "MINECRAFT_HOST": "localhost",
        "MINECRAFT_PORT": "25565",
        "MINECRAFT_USERNAME": "craftonomous",
        "MINECRAFT_AUTH": "offline",
        "CRAFTONOMOUS_PROFILE": "fair-play"
      }
    }
  }
}
```

Without a reachable body the server starts in a clearly labelled offline mode
and reports what is missing, rather than presenting a fabricated body at the
origin with full health.

Targets `@modelcontextprotocol/sdk` 1.30.0, speaking protocol `2025-11-25`. The
2026-07-28 specification adds `resultType`, multi-round-trip requests and
`subscriptions/listen`, none of which the SDK implements yet, so none are used.

## Core workflow

```text
minecraft server
  -> mineflayer binding
  -> perception gate, under a declared profile
  -> provenance-tagged observations
  -> skills, wrapped in timeout, interrupt and reliability accounting
  -> MCP surface
  -> any agent
  -> run manifest: outcome, perception report, skill reliability
```

A result is never just a success rate. It is a success rate next to the
perception profile it was earned under and the privileged-read share the agent
actually used.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Perception and fair play](docs/PERCEPTION.md)
- [Skill reliability](docs/SKILL_RELIABILITY.md)
- [Prior art survey](docs/PRIOR_ART.md)
- [Roadmap](docs/ROADMAP.md)

## Contributing

Run `npm test`, `npm run typecheck` and `npm run lint` before submitting
changes. Keep claims tied to what is actually implemented, and move an item out
of "what still requires execution" in the same change that makes it true. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Released under the [MIT License](LICENSE).
