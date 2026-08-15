# Skill reliability

## Why a skill count is not a skill library

Minecraft agent projects advertise skill counts. Odyssey publishes 205 skills,
mindcraft around 35, ADAM roughly 30. A count answers "how much was written."
It does not answer the question an agent actually needs answered at the moment
it must choose an action: **does this still work?**

Skills rot. A server updates, a mineflayer version changes a pathfinder
behaviour, a skill written against a plains biome meets a ravine. In the
[surveyed corpus](PRIOR_ART.md) only minecraft-agent-swarm tracks whether its
skills succeed and retires the ones that stop. The Voyager lineage generates
skills and stores them; it never closes the loop by measuring them.

## Not the success rate

The obvious measure is successes over attempts. It is a bad measure, and it is
bad in a specific way that matters here.

A freshly written skill has few attempts. If its first attempt succeeds, its
observed rate is 1.0: a perfect score, from one sample, for the code most
likely to be broken. Ranking on the observed rate puts brand-new untested
skills at the top of the list, precisely inverting what you want.

## Wilson score lower bound

Craftonomous ranks and gates on the lower bound of the Wilson score interval at
95% confidence:

```text
             p̂ + z²/2n − z·√( (p̂(1−p̂) + z²/4n) / n )
  lower  =  ─────────────────────────────────────────
                        1 + z²/n
```

It answers a different question: _given this evidence, what is the success rate
plausibly at least?_ Thin evidence is penalised rather than flattered.

| Record  | Observed rate | Wilson lower bound |
| ------- | ------------- | ------------------ |
| 1 / 1   | 1.00          | ≈ 0.21             |
| 5 / 5   | 1.00          | ≈ 0.57             |
| 50 / 50 | 1.00          | ≈ 0.93             |
| 38 / 40 | 0.95          | ≈ 0.84             |

The last two rows are the point. A skill with one lucky success ranks below a
skill with 38 successes out of 40, which is the ordering an agent should act on.

## Retirement

A skill is retired when it has enough evidence to judge and fails the bar. The
default policy is 8 attempts minimum and a confidence bound of 0.25.

An untried skill is **never** retired. Absence of evidence is not evidence of
failure, and a library that retires everything it has not yet exercised would
empty itself on first run.

Retirement is a signal, not a deletion. A retired skill stays in the library,
flagged, so that the reason it stopped working remains inspectable, and so
that a fix can be measured against the record that condemned it.

## What this does not yet do

- **No recency weighting.** A skill broken by yesterday's server update is
  still buoyed by last month's successes. A decay or windowed estimator is the
  obvious next step.
- **No context conditioning.** `mineBlock` may be reliable in plains and
  hopeless in a ravine, and one aggregate number hides that. Stats should
  eventually be keyed by situation.
- **No failure taxonomy.** A timeout, a missing precondition and a pathfinder
  giving up are all just "failed" today. They call for different responses.

Tracked in the [roadmap](ROADMAP.md).
