<h1 align="center">Craftonomous</h1>

<p align="center"><strong>Agent-Agnostic Minecraft Embodiment and Evaluation Substrate</strong></p>

Craftonomous puts an agent into Minecraft and measures what it does. It is not
a bot. It is the body, the senses and the scoreboard that a bot plugs into,
exposed over the [Model Context Protocol](https://modelcontextprotocol.io), so
you can drive it from Claude Code, from a local model, or from whatever
harness you already have.

The part that makes it different is the perception layer. Every fact the agent
receives is tagged with how it was obtained, and reads that no human player
could make are counted and reported. You can still let an agent see through
walls. You just cannot do it quietly.

## Why this exists

Most Minecraft agents read world state straight out of the game client. Block
types come back for any loaded coordinate, including the ones behind solid
stone, so an agent can locate diamond without ever going looking for it.

That would be fine if anyone said so. Almost nobody does. Out of 52
open-source Minecraft agent projects I read through before starting this one,
only two deliberately restrict what their agent can sense. The rest are
omniscient by default and silent about it, which means a published success
rate cannot distinguish an agent that dug an exploratory shaft from one that
read the ore through the wall. Those are different skills. A benchmark that
scores them the same is measuring something other than what its table says.

Craftonomous does not ban x-ray vision. Comparing a planner against a fixed
world model is a perfectly good experiment. It just makes the choice visible,
so a number always travels with the conditions that produced it.

## Install

```bash
git clone https://github.com/ReverseZoom2151/craftonomous.git
cd craftonomous
npm install
npm test
```

Node 22 or newer. You only need a Minecraft server for live play. Everything
else, including the whole test suite, runs offline.

## Connect it to an agent

```json
{
  "mcpServers": {
    "craftonomous": {
      "command": "node",
      "args": ["/path/to/craftonomous/dist/cli/main.js"],
      "env": {
        "MINECRAFT_HOST": "localhost",
        "MINECRAFT_PORT": "25565",
        "MINECRAFT_USERNAME": "craftonomous",
        "CRAFTONOMOUS_PROFILE": "fair-play"
      }
    }
  }
}
```

The agent gets the skills as tools and the world as resources it can read:
`craftonomous://body`, `://inventory`, `://surroundings`, `://perception` and
`://skills`. When a skill fails it comes back as a tool result carrying the
reason and whether retrying is worth it, so the model can correct itself
rather than being handed an opaque transport error.

Run `npm run build` first. The package is not on npm yet, so point the command
at the built entry point rather than at `npx`.

If there is no body to connect to, the server starts in offline mode and says
what is missing. It will not invent a body at the origin with full health.

## What a result looks like

```text
Craftonomous run report
suite: gathering v1.0.0 (66c29dd59d097bab)
agent: rule-policy

conditions
  profile=fair-play  privileged=0.0%  fair-play=yes
  sight=64  line-of-sight=required  hearing=16  privileged-reads=denied
  reads: 1713 total, 0 privileged

score  [profile=fair-play  privileged=0.0%  fair-play=yes]
  wilson lower bound : 0.267   (observed 55.6%, 5/9)
  mean steps         : 19.22
  outcomes           : success=5  failure=4  refused=0  timeout=0  error=0

tasks  [profile=fair-play  privileged=0.0%  fair-play=yes]
  task                      kind  credited    rate  wilson  steps
  --------------------  --------  --------  ------  ------  -----
  gather.logs.8         possible       1/1  100.0%   0.207   8.00
  craft.sticks.4        possible       1/1  100.0%   0.207  10.00
  craft.wooden-pickaxe  possible       0/1    0.0%   0.000  32.00
  craft.furnace         possible       0/1    0.0%   0.000  32.00

This score is valid only under profile "fair-play" with a privileged-read
share of 0.0%. Results earned under a different profile have not been compared.
```

That output is real, but the agent behind it is a stand-in that succeeds five
times and then stops. No agent has played on a live server yet.

Two things in there are deliberate. The headline number is a Wilson lower
bound rather than the observed rate, because five out of nine is not a 56%
agent, and three out of three is certainly not a perfect one. And the profile
is stamped on every block, including the task table, so it survives being
screenshotted into a slide.

## Perception profiles

| Profile      | Sight     | Through walls | Memory                 | Privileged reads |
| ------------ | --------- | ------------- | ---------------------- | ---------------- |
| `fair-play`  | 64 blocks | no            | fades after 10 minutes | denied           |
| `xray`       | 64 blocks | yes           | fades after 10 minutes | denied           |
| `omniscient` | unlimited | yes           | never fades            | allowed          |

`xray` is the interesting one. Same range as fair play, but occlusion is
switched off, so if an agent scores the same under both then finding things
was never its problem. That separates planning from exploration, which most
results conflate.

Occlusion is computed by walking the voxel grid between the agent's eyes and
whatever it is looking at, so a wall is a wall. It is not a flag the caller
sets.

## How it fits together

```text
minecraft server
  -> mineflayer binding
  -> perception gate, under a declared profile
  -> provenance-tagged observations
  -> skills, wrapped in timeouts, interrupts and reliability accounting
  -> MCP surface
  -> your agent
```

One rule holds the whole thing up: nothing above the perception gate is ever
handed a raw sensor. Skills do not get a bot object, and neither does the
reference agent. If they did, the ledger would be reporting a fiction.

Underneath the skills sits a layer of reflexes for lava, drowning, fire,
falling and starvation. They can interrupt whatever the planner is doing.
Drowning should not require a round trip to a language model.

Skills also track whether they still work. Every invocation records a success
or a failure, and a skill that stops working gets flagged rather than
silently degrading the agent that depends on it.

## Where it stands

The substrate is assembled and tested, all of it offline, at 949 tests. A
single call builds the whole stack over a live body or over an in-memory fake,
which is what lets the fake carry most of the suite.

What has not happened is a live game. The mineflayer binding typechecks and
its testable parts are covered, and there is a pinned server and a smoke test
waiting for it (see [live testing](docs/LIVE_TESTING.md)), but nothing has
connected to a real world and played. So there are no baselines and no numbers
worth quoting. That is the next thing, and it will find bugs.

Three known gaps are worth stating plainly, and the rest are in the
[roadmap](docs/ROADMAP.md).

Reconnection is written but inactive. `SessionSupervisor` handles death,
respawn and dropped sockets, and `connect()` does not build one, because the
sensor and actuator ports hold the bot they were constructed with and cannot
rebind. A supervisor that swapped its bot would leave those ports talking to a
dead socket while reporting a successful recovery, which is worse than not
reconnecting at all. Rebinding the ports is the prerequisite.

Testimony establishes opportunity, not truth. The agent can check whether it
ever saw a speaker near the place they are talking about. A player standing on
diamonds can still lie, and nothing here will catch that.

The offline world teleports instead of pathfinding, so it will not catch a
skill that assumes it can walk somewhere unreachable. Three shipped goals need
positions the symbolic sandbox does not model, and report themselves as
unscorable there rather than as failures.

## Scope

Java Edition only, from 1.8 through 1.21.11, over the ordinary Minecraft
protocol. No JDK required. Bedrock add-on scripting is a different
architecture entirely and is out of scope.

Craftonomous is clean-room. The projects surveyed in
[prior art](docs/PRIOR_ART.md) were read and are cited, but no code was copied
from them, and that corpus is kept out of the build and the test runner.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Perception and fair play](docs/PERCEPTION.md)
- [Skill reliability](docs/SKILL_RELIABILITY.md)
- [Live testing](docs/LIVE_TESTING.md), including the rate limits to respect
- [Prior art survey](docs/PRIOR_ART.md), covering all 52 projects
- [Roadmap](docs/ROADMAP.md)

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to run the checks and what the
clean-room rule means in practice.

## License

[MIT](LICENSE).
