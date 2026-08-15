<h1 align="center">Craftonomous</h1>

<p align="center"><strong>Agent-Agnostic Minecraft Embodiment and Evaluation Substrate</strong></p>

An in-progress, test-driven substrate for putting agents into Minecraft and
measuring them honestly. Craftonomous is not another bot. It is the body, the
senses, the skill library and the scoreboard that a bot plugs into, exposed
over the [Model Context Protocol](https://modelcontextprotocol.io) so that any
agent can drive it.

It is not a finished platform: this repository contains no trained weights, no
published benchmark results, and no claimed task success rates. What it
contains today is the contract layer those numbers would have to be measured
through.

The design follows a survey of 52 open-source Minecraft-agent repositories
(see [prior art](docs/PRIOR_ART.md)). Three findings shaped it. Five separate
projects independently began decoupling Minecraft control from agent reasoning
and none finished. Published benchmarks are largely unreproducible, several
pinned to a Minecraft version and JDK from 2021. And almost every agent reads
world state directly out of the game client, so no published comparison
distinguishes an agent that explored a cave from one that read through the wall.

## What is implemented

- An observation contract in which every fact carries its provenance —
  proprioception, sight, hearing, memory, inference, testimony, or privileged —
  with pessimistic combination, so a privileged read cannot be laundered by
  deriving something from it.
- A perception gate enforcing declared sensory limits: sight range, line-of-sight
  occlusion, hearing range, and a memory horizon past which facts are forgotten.
  Three built-in profiles: `fair-play`, `xray`, and `omniscient`.
- A perception ledger that counts every read by provenance and reports the
  privileged share of a run, making the cost of cheating visible in results
  rather than assumed away.
- Reliability tracking for skills using a Wilson score lower bound, so a skill
  that succeeded once is scored near 0.21 rather than 1.0, and retirement gates
  on evidence rather than luck.
- A deterministic injected clock, so memory decay, staleness and skill timing
  are reproducible under test and on replay.
- Offline unit tests across the contract layer, with the surveyed corpus held
  strictly outside the build and test graph.

## What still requires execution

The mineflayer binding, the skill library, the MCP server surface, and the
evaluation harness are designed but not yet built. No agent runs end to end
today. See the [roadmap](docs/ROADMAP.md) for sequencing and
[architecture](docs/ARCHITECTURE.md) for how the pieces are meant to fit.

Craftonomous is clean-room. The surveyed repositories under `reference_repos/`
are read as prior art and cited; no code is copied from them. That directory is
excluded from version control, the build, and the test runner.

## Install

```bash
git clone https://github.com/ReverseZoom2151/craftonomous.git
cd craftonomous

npm install
npm test
```

Node 22 or newer. A Minecraft Java Edition server is needed only once the
embodiment layer lands; the contract layer and its tests run entirely offline.

## Core workflow

```text
minecraft server
  → mineflayer binding
  → perception gate (declared profile)
  → provenance-tagged observations
  → skills, wrapped in timeout / interrupt / reliability accounting
  → MCP surface
  → any agent
  → run manifest: outcome + perception report + skill reliability
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

Run `npm test` and `npm run typecheck` before submitting changes. Keep claims
tied to what is actually implemented, and move an item out of "what still
requires execution" in the same change that makes it true.

## License

Released under the [MIT License](LICENSE).
