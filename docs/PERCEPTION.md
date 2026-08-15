# Perception and fair play

## The problem

An agent driving Minecraft through a bot library can read the world directly.
Block types are available for any coordinate the client has loaded, including
coordinates behind solid stone. Entity positions are available across the whole
loaded area, through walls and around corners. Chest contents, mob health,
biome data and light levels are all one property access away.

Almost every agent in the [surveyed corpus](PRIOR_ART.md) does exactly this, and
none of them report it. The consequence is that a published task success rate
does not distinguish:

- an agent that lit torches, dug an exploratory shaft and found iron, from
- an agent that scanned every block in a 64-block radius and walked straight to it.

Those are different capabilities. A benchmark that scores them identically is
not measuring what its results table claims.

Two projects in the corpus restrict senses deliberately: hermescraft, whose
perception module is explicitly non-omniscient, and MineLand, which models
limited multimodal senses including audio. Everywhere else, omniscience is the
silent default.

## The approach

Craftonomous does not ban privileged reads. Banning them would be the wrong
call: comparing a planner against a fixed world model is a legitimate
experiment, and forcing exploration into every study conflates two abilities
that are worth separating.

Instead, privileged reads are **declared, enforced and counted**.

### Provenance

Every fact handed to an agent is an `Observed<T>` carrying how it was obtained:

| Provenance | Meaning |
|---|---|
| `proprioception` | The agent's own body: position, health, hunger, inventory |
| `sight` | Currently in range and unoccluded |
| `hearing` | An audible event with a bearing but no exact source |
| `memory` | Previously sensed, now recalled, possibly stale |
| `inference` | Derived by rule from other observations |
| `testimony` | Told to the agent by another agent or a human |
| `privileged` | Read from game state in a way no player could achieve |

Provenance combines pessimistically. A derived fact is no fresher and no more
directly grounded than its weakest premise, so anything computed from a
privileged read is itself privileged. The taint cannot be laundered by
deriving something from it, which matters, because laundering is exactly what
a sufficiently clever agent implementation would otherwise do by accident.

### Profiles

A `PerceptionProfile` declares the limits a run operates under.

| Profile | Sight | Occlusion | Hearing | Memory | Privileged |
|---|---|---|---|---|---|
| `fair-play` | 64 blocks | enforced | 16 blocks | 10 minutes | denied |
| `xray` | 64 blocks | ignored | 16 blocks | 10 minutes | denied |
| `omniscient` | unlimited | ignored | unlimited | never fades | allowed |

`xray` exists to isolate planning from exploration: identical range, no
occlusion. If an agent scores the same under `fair-play` and `xray`, its
bottleneck was never finding things.

`omniscient` is what most prior agents run under. It is named so that choosing
it is a visible decision rather than an unexamined default.

A profile is part of a run's identity. Two agents measured under different
profiles have not been compared, and Craftonomous prints the profile with every
result so that the difference cannot be quietly dropped from a table.

### Enforcement

The `PerceptionGate` sits between the game and every skill. Skills never touch
the underlying client; that is what keeps the accounting honest, and it is the
main structural constraint the rest of the codebase is built around.

A denied read **throws** rather than returning nothing. A silently dropped read
would leave the agent mysteriously less capable with the cause buried several
layers down. Failing loudly makes the profile's effect obvious at the moment it
bites.

Out-of-range sightings return `undefined`, meaning *not known*, which is
different from *not there*. Neither a denied read nor an out-of-range one is
counted, because neither happened.

### Line of sight

Occlusion is computed, not asserted. `isOccluded` walks the voxel grid between
two points using an Amanatides and Woo style DDA, stepping one block at a time
along whichever axis reaches its next voxel plane soonest, and reports whether
any solid block stands on the path. Both the mineflayer binding and the
in-memory fake share that traversal and differ only in how they answer "is this
block solid", so a test and a live run disagree about visibility only when the
world genuinely differs.

Two decisions inside it are worth knowing. Both endpoint voxels are excluded
from the occlusion test, so an agent is not blinded by the block it is standing
in, nor by the block it is looking at; without that exclusion an ore would hide
itself at the exact moment it came into view. And traversal is capped at a fixed
number of steps (`MAX_TRAVERSAL_STEPS`, currently 4096), with non-finite
endpoints refused before any stepping happens, so a NaN arriving from the
substrate or a ray asked to cross the whole world degrades into "not occluded"
rather than hanging the tick that perception runs on.

### Memory and recall

When a block cannot be seen right now, the adapter falls back to what it
remembers, and returns it tagged `memory` carrying the age of the recollection
in milliseconds. A caller therefore cannot mistake a five-minute-old belief for
a present-tense sighting. Memory is bounded: past its cap it evicts the
oldest-sensed entry first, on the grounds that the beliefs worth shedding are
the ones least likely to still be true rather than the ones least recently
asked about. Anything past the profile's horizon is dropped instead of returned.

Recalls are recorded on the ledger directly rather than through `gate.sense`.
That is deliberate. `sense` stamps the present time, which would erase exactly
the staleness the memory tag exists to convey and quietly promote an old belief
to a fresh one at the moment of reading.

### The ledger

`PerceptionLedger` tallies every read by provenance and reports:

- total observations
- privileged count
- privileged share of all reads
- whether the run was fair play throughout

This turns "did it cheat" from an assumption into a number that ships with the
result. An agent with a 12% privileged share is not disqualified. It is
described.

## What this does not solve

Occlusion is computed rather than assumed, so what remains open is elsewhere.

Memory decay is a fixed horizon rather than a model of forgetting: a
recollection is exact right up until the moment it is deleted, which is not how
knowing things works. Testimony is not verified against what the speaker could
actually have known, so a lying agent is taken at its word. And `hearing` exists
in the provenance contract and in the gate, which will admit a sound within
range, but no sensor currently produces sound events, so nothing in a run is
ever tagged with it. The hearing ranges in the profile table are a declaration
still waiting for something to declare against.

These are tracked in the [roadmap](ROADMAP.md).
