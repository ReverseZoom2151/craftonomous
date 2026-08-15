# Roadmap

Sequencing for Craftonomous. Items move out of this file and into the README's
"what is implemented" list in the same change that makes them true.

## Landed

- **Observation contract.** Provenance tagging, pessimistic combination, recall
  with staleness. `src/observation/`
- **Perception gate.** Profiles, range and occlusion checks, memory horizon,
  denial semantics. `src/perception/`
- **Perception ledger.** Per-provenance tallies, privileged share, fair-play
  verdict. `src/perception/ledger.ts`
- **Reliability tracking.** Wilson lower bound, ranking, retirement policy.
  `src/skills/reliability.ts`
- **Deterministic clock.** `src/runtime/clock.ts`

## Next: embodiment

Bind mineflayer behind the perception gate.

- Bot lifecycle: connect, spawn, respawn, disconnect, reconnect
- A raycast good enough to make `requireLineOfSight` mean something. Occlusion
  is currently a parameter the caller supplies; nothing computes it yet, which
  makes `fair-play` only as honest as its callers.
- Block, entity and container queries routed through the gate
- Proprioception: position, health, hunger, inventory, held item
- Sound events with bearing but not exact source

The occlusion raycast is the critical item. Until it exists, the perception
thesis is a contract without an enforcer.

## Then: skills

Narrow and deep. Clean-room means each skill is written and measured here, so
breadth is expensive and coverage claims must stay modest.

- Skill schema: Zod input/output, declared preconditions, structured results
- Invocation wrapper: timeout, interrupt, cancellation, reliability recording
- A reflex layer that can pre-empt a running skill — drowning, fire, falling,
  low health. Prior art is clear that this belongs below the planner, not in it
- A first skill set: move, dig, place, craft, smelt, container in/out, equip,
  consume, attack
- Failure taxonomy so that timeout, unmet precondition and pathfinder-gave-up
  are distinguishable

## Then: MCP surface

- Skills exposed as MCP tools with generated schemas
- World state exposed as MCP resources
- Run manifest as structured output: outcome, perception report, reliability
  table, profile
- A stdio server, so any MCP client can drive it without a bespoke integration

## Then: evaluation

- Offline symbolic sandbox over extracted recipe, tag and loot-table data, for
  CI-speed regression without a server
- Live scenario runner against a pinned modern server
- Versioned task manifests, so a result names the exact task set it was earned on
- Report format that prints the perception profile next to every score

## Then: reference agent

A client of the MCP surface with no privileged access, existing to prove the
substrate is usable and to give the benchmark a baseline.

## Research directions

Deliberately after the substrate, not before.

- **Rule learning from failure.** WALL-E mines action preconditions from an
  agent's own failed attempts — propose, refine, prune by maximum coverage — but
  demonstrates it on a 2D Crafter clone, not Minecraft. Applying it to real
  Minecraft crafting and interaction preconditions appears to be unexplored.
- **Experience-corrected world model.** XENON maintains a hypothesised recipe
  graph and repairs it from experience. Complementary to the above: one learns
  rules, the other repairs a structured prior.
- **Skill boundaries from surprisal.** SkillDiscovery segments unlabelled
  gameplay by watching a frozen policy's own prediction loss spike. A route to
  growing a skill library from recordings without hand-labelling.
- **Task-DAG planning.** VillagerAgent's dependency graph with bounded lookahead
  is the strongest multi-agent scheduling design in the survey.

## Known gaps in what has landed

- Occlusion is supplied by callers, not computed
- Memory decay is a fixed horizon, not a model of forgetting
- Testimony is unverified: a lying agent is believed
- Reliability has no recency weighting and no per-context conditioning
