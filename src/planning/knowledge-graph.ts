/**
 * A hypothesised world model that experience is allowed to overrule.
 *
 * XENON's contribution is not the recipe graph — everyone has one — it is that
 * the graph is a *prior*, seeded from something unreliable (a model's guess, a
 * wiki scrape, a previous game version) and then repaired by what actually
 * happened. The reimplementation here keeps that shape and adds the property
 * the roadmap says is missing everywhere: a seeded edge that is repeatedly
 * contradicted must be able to fall out of belief entirely. A prior you cannot
 * unlearn is not a prior, it is a hardcode.
 *
 * Confidence moves in log-odds. That choice does the work: additive evidence
 * gives diminishing returns near certainty and never overshoots 0 or 1, so a
 * confidently-wrong seed takes real evidence to dislodge but does eventually
 * dislodge, rather than converging to a floor above the belief threshold.
 */

export type Relation = 'produces' | 'requires';

export interface EdgeKey {
  readonly from: string;
  readonly to: string;
  readonly relation: Relation;
}

export interface Edge extends EdgeKey {
  readonly confidence: number;
  /** Observations consistent with the edge. */
  readonly supporting: number;
  /** Observations contradicting it. */
  readonly contradicting: number;
  /** Confidence it was seeded with, kept so drift is inspectable. */
  readonly prior: number;
  readonly source: EdgeSource;
}

export type EdgeSource = 'hypothesis' | 'observation';

export interface EdgeSeed extends EdgeKey {
  /** Prior belief. Default 0.5 — an honest shrug. */
  readonly confidence?: number;
}

export interface Observation extends EdgeKey {
  /** Did the relation hold this time? */
  readonly held: boolean;
  /**
   * Strength of this single observation, in evidence units. 1 is a plain
   * attempt; use less for ambiguous evidence (an action that failed for a
   * reason that may have nothing to do with this edge). Default 1.
   */
  readonly weight?: number;
}

export interface KnowledgeGraphOptions {
  /**
   * Log-odds moved per unit of evidence. Higher learns faster and is noisier.
   * Default 0.85, about a 2.3x odds shift per observation.
   */
  readonly learningRate?: number;
  /** Confidence assigned to an edge first seen in an observation. Default 0.5. */
  readonly discoveryPrior?: number;
  /** Default belief threshold for `believed()`. Default 0.5. */
  readonly threshold?: number;
}

const DEFAULT_RATE = 0.85;
const DEFAULT_DISCOVERY = 0.5;
const DEFAULT_THRESHOLD = 0.5;

/** Keeps log-odds finite, so no amount of evidence can pin a belief forever. */
const EPS = 1e-4;

/**
 * Saturation bound on accumulated log-odds, equal to `logit(1 - EPS)`.
 *
 * Without it, a hundred consistent observations push confidence to exactly 1.0
 * in floating point and the edge becomes unfalsifiable — the failure this whole
 * module exists to avoid. Bounding the belief means a long-held certainty can
 * still be overturned by a bounded amount of contrary evidence.
 */
const MAX_LOG_ODDS = Math.log((1 - EPS) / EPS);

function clamp(p: number): number {
  return Math.min(1 - EPS, Math.max(EPS, p));
}

function logit(p: number): number {
  const c = clamp(p);
  return Math.log(c / (1 - c));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function edgeKey(e: EdgeKey): string {
  return `${e.from}|${e.relation}|${e.to}`;
}

interface MutableEdge {
  from: string;
  to: string;
  relation: Relation;
  logOdds: number;
  supporting: number;
  contradicting: number;
  prior: number;
  source: EdgeSource;
}

export class KnowledgeGraph {
  readonly #edges = new Map<string, MutableEdge>();
  readonly #rate: number;
  readonly #discovery: number;
  readonly #threshold: number;

  constructor(options: KnowledgeGraphOptions = {}) {
    this.#rate = options.learningRate ?? DEFAULT_RATE;
    this.#discovery = options.discoveryPrior ?? DEFAULT_DISCOVERY;
    this.#threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (this.#rate <= 0) throw new RangeError('learningRate must be > 0');
  }

  get size(): number {
    return this.#edges.size;
  }

  /**
   * Seed a prior. Re-seeding an existing edge resets it — a seed is a statement
   * about what we believe before evidence, so it cannot be allowed to
   * accumulate as though it were evidence.
   */
  hypothesise(seeds: Iterable<EdgeSeed>): this {
    for (const s of seeds) {
      const p = s.confidence ?? DEFAULT_DISCOVERY;
      if (p <= 0 || p >= 1) {
        throw new RangeError(
          `prior for ${edgeKey(s)} must lie strictly between 0 and 1, got ${p}`,
        );
      }
      this.#edges.set(edgeKey(s), {
        from: s.from,
        to: s.to,
        relation: s.relation,
        logOdds: logit(p),
        supporting: 0,
        contradicting: 0,
        prior: p,
        source: 'hypothesis',
      });
    }
    return this;
  }

  /**
   * Fold one observation into the graph.
   *
   * An observation about an edge nobody hypothesised creates it at the
   * discovery prior: the agent is allowed to learn relations the seed never
   * mentioned, which is the other half of correcting a bad prior.
   */
  correct(observation: Observation): Edge {
    const key = edgeKey(observation);
    const weight = observation.weight ?? 1;
    if (weight <= 0) throw new RangeError('observation weight must be > 0');

    let e = this.#edges.get(key);
    if (!e) {
      e = {
        from: observation.from,
        to: observation.to,
        relation: observation.relation,
        logOdds: logit(this.#discovery),
        supporting: 0,
        contradicting: 0,
        prior: this.#discovery,
        source: 'observation',
      };
      this.#edges.set(key, e);
    }

    const delta = this.#rate * weight;
    e.logOdds = Math.min(
      MAX_LOG_ODDS,
      Math.max(-MAX_LOG_ODDS, e.logOdds + (observation.held ? delta : -delta)),
    );
    if (observation.held) e.supporting += weight;
    else e.contradicting += weight;
    return this.#freeze(e);
  }

  /** Fold in a batch, in order. */
  correctAll(observations: Iterable<Observation>): this {
    for (const o of observations) this.correct(o);
    return this;
  }

  confidenceOf(key: EdgeKey): number | undefined {
    const e = this.#edges.get(edgeKey(key));
    return e ? sigmoid(e.logOdds) : undefined;
  }

  edge(key: EdgeKey): Edge | undefined {
    const e = this.#edges.get(edgeKey(key));
    return e ? this.#freeze(e) : undefined;
  }

  /** Every edge, believed or not, most confident first. */
  edges(): readonly Edge[] {
    return [...this.#edges.values()]
      .map((e) => this.#freeze(e))
      .sort(
        (a, b) =>
          b.confidence - a.confidence || edgeKey(a).localeCompare(edgeKey(b)),
      );
  }

  /**
   * The subgraph currently trusted at `threshold`. Returned as a graph rather
   * than a list so a planner can be handed beliefs and nothing else — it should
   * not be able to accidentally read an edge the evidence has retired.
   */
  believed(threshold: number = this.#threshold): KnowledgeGraph {
    const out = new KnowledgeGraph({
      learningRate: this.#rate,
      discoveryPrior: this.#discovery,
      threshold,
    });
    for (const [key, e] of this.#edges) {
      if (sigmoid(e.logOdds) < threshold) continue;
      out.#edges.set(key, { ...e });
    }
    return out;
  }

  /** Believed edges asserting that `item` is produced by something. */
  producedBy(
    item: string,
    threshold: number = this.#threshold,
  ): readonly Edge[] {
    return this.edges().filter(
      (e) =>
        e.relation === 'produces' && e.to === item && e.confidence >= threshold,
    );
  }

  /** Believed edges asserting that `item` requires something. */
  requirementsFor(
    item: string,
    threshold: number = this.#threshold,
  ): readonly Edge[] {
    return this.edges().filter(
      (e) =>
        e.relation === 'requires' &&
        e.from === item &&
        e.confidence >= threshold,
    );
  }

  /**
   * Edges that were seeded confidently and have since been contradicted below
   * the threshold. Worth surfacing: each one is a place the prior was wrong,
   * which is the finding, not a bug.
   */
  unlearned(threshold: number = this.#threshold): readonly Edge[] {
    return this.edges().filter(
      (e) =>
        e.source === 'hypothesis' &&
        e.prior >= threshold &&
        e.confidence < threshold,
    );
  }

  toMermaid(threshold: number = this.#threshold): string {
    const lines = ['flowchart LR'];
    const ids = new Map<string, string>();
    const idFor = (name: string): string => {
      const existing = ids.get(name);
      if (existing !== undefined) return existing;
      const id = `n${ids.size}`;
      ids.set(name, id);
      lines.push(`  ${id}["${name}"]`);
      return id;
    };
    for (const e of this.edges()) {
      if (e.confidence < threshold) continue;
      const a = idFor(e.from);
      const b = idFor(e.to);
      lines.push(`  ${a} -->|${e.relation} ${e.confidence.toFixed(2)}| ${b}`);
    }
    return lines.join('\n');
  }

  #freeze(e: MutableEdge): Edge {
    return {
      from: e.from,
      to: e.to,
      relation: e.relation,
      confidence: sigmoid(e.logOdds),
      supporting: e.supporting,
      contradicting: e.contradicting,
      prior: e.prior,
      source: e.source,
    };
  }
}
