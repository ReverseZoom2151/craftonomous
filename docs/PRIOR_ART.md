# Prior art

A survey of 52 open-source Minecraft-agent repositories, read end to end before
any code was written here. Craftonomous is clean-room: these were read for ideas
and are cited; no code was copied from them.

License notes are recorded from the repository snapshots surveyed. Several
projects display a license *badge* pointing at a dependency's license, most
often MineCLIP's MIT, while shipping no license of their own. A badge does not
license the code beneath it. Where no `LICENSE` file was found, the code is
treated as all-rights-reserved and was not used as a source at all.

## The split

The field divides into two families that barely interoperate.

| | Mineflayer family | MineRL / Malmo family |
|---|---|---|
| Transport | Minecraft protocol client (JS) | Modded Java client, Python bridge |
| Versions | 1.8 – 1.21.11 | ~1.11.2 – 1.16.5 |
| Java | none | JDK 8 only |
| Health | actively released | largely frozen since 2023 |
| Licensing | MIT throughout | **minerl is CC BY-NC-SA (NonCommercial)** |

The NonCommercial term on minerl sits underneath most of the Python family and
propagates. It is the main reason Craftonomous builds on mineflayer.

## Foundational infrastructure

| Repo | Origin | Layer | License |
|---|---|---|---|
| mineflayer | PrismarineJS | Protocol client, ~35-plugin API, MC 1.8–1.21.11 | MIT |
| MineDojo | NeurIPS 2022 (Outstanding Paper) | Malmo sim, 1000+ task YAMLs, internet-scale KB | MIT (wiki data CC BY-NC-SA) |
| minerl | MineRL / BASALT | Gym env underlying VPT | **CC BY-NC-SA 4.0** |
| MineStudio | arXiv 2412.18293 | Data, models, training, 153 eval tasks | MIT (vendors minerl, a conflict) |
| Vereya | trueagi-io | Fabric mod, **MC 1.21**, Malmo-style typed API | none found |
| craftium | ICML 2025 | Luanti engine, not Minecraft; `sync_mode` for slow agents | LGPL + mixed assets |
| marLo | MarLÖ 2018 | Malmo Gym wrapper, ~25 task XMLs | MIT (unmaintained) |

## Agent frameworks

| Repo | Origin | Notes | License |
|---|---|---|---|
| mindcraft | MineCollab | Reference architecture. Reflexive `modes.js`, action manager with timeout/interrupt/loop-detection, 20 LLM providers | MIT |
| Odyssey | IJCAI 2025 | **205 mineflayer skills** with NL descriptions; 390k-instruction wiki QA set | MIT |
| minecraft-ai | mindcraft fork | Refactors hardcoded subsystems into a plugin system | MIT |
| minecraft-agent-swarm | community | Dynamic skill generation + **reliability tracking with auto-retirement**; ~60 hardening tests | MIT |
| minecraft-agent | justjavac | Daemon + typed CLI + JSON observations, packaged as a coding-agent skill | MIT |
| airi-minecraft | Project Airi | Cleanest TS scaffold: Zod tool schemas, DI, real tests. Archived into monorepo | MIT |
| ADAM | arXiv 2410.22194 | Causal tech-tree graph; 30+ JS action primitives | Apache-2.0 |
| MineLand | arXiv 2403.19267 | **48 concurrent bots**; limited senses incl. simulated audio | MIT |
| hermescraft | Nous hackathon | **Fair-play, non-omniscient perception**; 50-verb CLI; persona prompts | MIT |
| haksnbot-mind | community | Claude Agent SDK + MCP tool servers; async log-tail event loop | MIT |
| clawcraft | TreeHacks 2026 | Competitive arena for agents; vendors mindcraft; MCP + REST | none found |
| gemini-minecraft | indie | Fabric mod; **structured phased build plans** with validation, auto-repair, undo; MCP bridge | MIT |
| AgentCraft | community | Spigot plugin, packet-level NPCs, 35 tools, Qdrant memory | none set |
| interactive-minecraft-npcs | Microsoft, NAACL 2022 | Ancestor of the Voyager lineage; `eval()`s LLM-generated JS | MIT |
| Minecraft-God-AI | mindcraft fork | Multi-agent civilisation experiments | MIT |
| amazon-bedrock-minecraft-agent | AWS sample | Minimal typed action dispatch | **MIT-0** |
| Steve | indie | Forge mod; ServiceLoader plugin actions; collaborative build partitioning | MIT (no file) |
| minecraft-ai / BuilderGPT | CyniaAI | LLM emits JS build DSL, validated against a block allow-list | Apache-2.0 |

## Planning, memory and reasoning

| Repo | Origin | Contribution | License |
|---|---|---|---|
| VillagerAgent | ACL 2024 | **Task-DAG engine** with recursive splice, ready-frontier scheduling, bounded 5-node lookahead | none found |
| BAR | arXiv 2505.14079 | **Backward** goal decomposition from terminal state + consistency repair | Apache-2.0 |
| MC-Planner (DEPS) | arXiv 2302.01560 | `goal_lib.json` skill schema; plan/explain/replan prompts. Code dead (Codex) | none found |
| Plan4MC | arXiv 2303.16563 | STRIPS-style `skills.yaml` + dependency-free recursive planner | MIT |
| JARVIS-1 | arXiv 2311.05997 | 200+ task specs with spawn configs; skill schema. Core planner withheld | none found |
| Optimus-1 | NeurIPS 2024 | Knowledge-graph long-horizon memory | none (vendors NC minerl) |
| XENON | ICLR 2026 | **Experience-corrected recipe graph** against real Minecraft | none found |
| WALL-E | NeurIPS 2025 | Rule mining: propose → refine → prune by max-coverage. **Environment is 2D Crafter, not Minecraft** | Mars subdir only |
| MP5 | CVPR 2024 | Active-perception prompt library; Chroma workflow memory | Apache-2.0 (subdir) |
| GITM | arXiv 2305.17144 | **No code released** | n/a |

## Policies and perception models

| Repo | Origin | Contribution | License |
|---|---|---|---|
| STEVE-1 | arXiv 2306.00937 | MineCLIP-embedding-conditioned VPT + text→embedding CVAE prior; CFG on action logits | none found |
| ROCKET-1 | CVPR 2025 | Segmentation-mask interaction grounding; recipe JSON DB | none found |
| ROCKET-2 | arXiv 2503.02505 | Cross-view goal alignment; HF checkpoints | none found |
| OpenHA | arXiv 2509.13347 | Hierarchical VLM agent; published HF checkpoint; verl RL stack | MIT |
| Optimus-3 | arXiv 2506.10357 | Dual-router MoE across plan/ground/reflect/act | MIT |
| SkillDiscovery | arXiv 2503.10684 | **Skill boundaries from policy loss spikes**, unsupervised segmentation | MIT |
| MineDreamer | IROS 2025 | Chain-of-Imagination: diffuse a goal frame, then steer toward it | Apache-2.0 |
| GROOT | arXiv 2310.08235 | Video-conditioned instruction following | none found |
| CLIP4MC | ECCV 2024 | RL-friendly video-text reward model; task prompt bank | MIT |
| PTGM | ICLR 2024 oral | Goal-embedding clustering into a discrete skill vocabulary | none found |
| STG-Transformer | NeurIPS 2023 | Intrinsic reward from offline video prediction | MIT |
| MC-Controller | arXiv 2301.10034 | Goal-conditioned control; vendored VPT action space | none found |
| JarvisVLA | arXiv 2503.16365 | VLA over MineStudio; scripted GUI crafting worker | none found |

## Benchmarks

| Repo | Origin | Scoring | License |
|---|---|---|---|
| plancraft | COLM 2025 | **Offline symbolic** crafting; optimal paths, difficulty bins, impossible tasks testing refusal; ships an MCP server. README notes its own published baselines were invalidated by a fixed bug | MIT |
| PillagerBench | IEEE CoG 2025 | Live **team-vs-team** competitive scenarios; continuous score from server state | MIT |
| MCU | arXiv 2310.08367 | 80 atomic + 20 compositional tasks; VLM judge | none found |
| MineAnyBuild | NeurIPS 2025 D&B | Spatial planning on a 4-dimension rubric | none found |
| MC-TextWorld | CraftJarvis | Engine-free symbolic mine/craft/smelt over extracted game data | MIT claimed, no file |

## Released without code

GITM, Optimus-2, ROCKET-3, Steve-Eye, STEVE2, and minecraft-rl-example contain
README, figures or a PDF and no implementation. `BAR-main (1)` is a byte-identical
duplicate of `BAR-main`.

## What this survey concluded

**Convergence nobody completed.** haksnbot, clawcraft, gemini-minecraft,
justjavac's minecraft-agent and plancraft each independently began exposing
Minecraft control as an agent-callable tool surface. None shipped a complete,
versioned specification. That is the gap Craftonomous targets.

**Benchmarks that cannot be trusted.** plancraft states its own published
baselines were wrong. MCU and MineAnyBuild score with a VLM judge. Task suites
are pinned to MC 1.16.5 and JDK 8, with checkpoints behind links that have
already begun to rot.

**Undeclared omniscience.** Only hermescraft and MineLand deliberately restrict
what an agent may sense. Everywhere else, agents read block types through walls
and entity positions across chunks, and no results table records it. This is
why provenance is a first-class property here rather than an afterthought.
