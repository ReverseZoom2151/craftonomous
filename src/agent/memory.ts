import type { Vec3Like } from '../embodiment/geometry.js';
import type { Clock } from '../runtime/clock.js';

/**
 * Episode memory with rolling summarisation.
 *
 * The failure mode this avoids: a loop that drops the oldest turns when the
 * context fills. The agent then confidently repeats work it already did and
 * failed at, because the evidence was silently deleted. Folding the oldest
 * turns into a summary keeps the shape of what happened at a fraction of the
 * cost, which is the honest trade.
 *
 * Durable knowledge (facts learned, places named) lives in a separate list
 * that summarisation never touches. Where the diamonds are should not decay
 * because the conversation got long.
 */

export type TurnRole =
  'system' | 'user' | 'agent' | 'observation' | 'action' | 'outcome';

export interface Turn {
  readonly role: TurnRole;
  readonly text: string;
  readonly at: number;
}

export interface Fact {
  readonly text: string;
  readonly learnedAt: number;
  readonly source?: string;
}

export interface NamedLocation {
  readonly name: string;
  readonly position: Vec3Like;
  readonly recordedAt: number;
  readonly note?: string;
}

/** A read-only view of memory, for handing to a policy. */
export interface MemorySnapshot {
  readonly summary: string | undefined;
  readonly turns: readonly Turn[];
  readonly facts: readonly Fact[];
  readonly locations: readonly NamedLocation[];
}

/**
 * Folds turns into a summary. Takes the previous summary so summarisation is
 * cumulative rather than a series of unrelated paragraphs.
 *
 * An LLM-backed implementation drops in here; the default is deterministic so
 * the whole loop stays testable offline.
 */
export type Summariser = (
  folded: readonly Turn[],
  previous: string | undefined,
) => string;

const CONDENSED = /^- \[(\d+) intervening turns condensed\]$/;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The default summariser: one bullet per folded turn, capped in length.
 *
 * When the cap bites it condenses from the middle, so the earliest turns (the
 * ones nothing else can recover) and the most recent ones both survive.
 */
export function createSummariser(
  options: { readonly maxChars?: number; readonly maxTurnChars?: number } = {},
): Summariser {
  const maxChars = options.maxChars ?? 1200;
  const maxTurnChars = options.maxTurnChars ?? 160;

  return (folded, previous) => {
    const lines: string[] = [];
    let condensed = 0;
    for (const line of previous ? previous.split('\n') : []) {
      const m = CONDENSED.exec(line);
      if (m?.[1] !== undefined) condensed += Number(m[1]);
      else if (line.length > 0) lines.push(line);
    }
    for (const t of folded) {
      lines.push(`- ${t.role}: ${clip(t.text, maxTurnChars)}`);
    }

    while (lines.join('\n').length > maxChars && lines.length > 2) {
      lines.splice(Math.floor(lines.length / 2), 1);
      condensed += 1;
    }
    if (condensed > 0) {
      lines.splice(
        Math.floor(lines.length / 2),
        0,
        `- [${condensed} intervening turns condensed]`,
      );
    }
    return lines.join('\n');
  };
}

export interface AgentMemoryOptions {
  readonly clock: Clock;
  /** Characters of live turns tolerated before folding. Default 4000. */
  readonly budgetChars?: number;
  /** Turns always kept verbatim, however tight the budget. Default 4. */
  readonly keepRecent?: number;
  readonly summarise?: Summariser;
  /** Cap on durable facts; oldest fall off. Default 128. */
  readonly maxFacts?: number;
}

export class AgentMemory {
  readonly #clock: Clock;
  readonly #budget: number;
  readonly #keepRecent: number;
  readonly #summarise: Summariser;
  readonly #maxFacts: number;

  #turns: Turn[] = [];
  #chars = 0;
  #summary: string | undefined;
  #folded = 0;
  #facts: Fact[] = [];
  #locations = new Map<string, NamedLocation>();

  constructor(options: AgentMemoryOptions) {
    this.#clock = options.clock;
    this.#budget = options.budgetChars ?? 4000;
    this.#keepRecent = Math.max(0, options.keepRecent ?? 4);
    this.#summarise = options.summarise ?? createSummariser();
    this.#maxFacts = options.maxFacts ?? 128;
  }

  append(role: TurnRole, text: string): Turn {
    const turn: Turn = { role, text, at: this.#clock.now() };
    this.#turns.push(turn);
    this.#chars += text.length;
    this.#fold();
    return turn;
  }

  /** Fold the oldest turns into the summary until back inside budget. */
  #fold(): void {
    if (this.#chars <= this.#budget) return;
    const folded: Turn[] = [];
    while (
      this.#chars > this.#budget &&
      this.#turns.length > this.#keepRecent
    ) {
      const oldest = this.#turns.shift();
      if (!oldest) break;
      this.#chars -= oldest.text.length;
      folded.push(oldest);
    }
    if (folded.length === 0) return;
    this.#folded += folded.length;
    this.#summary = this.#summarise(folded, this.#summary);
  }

  /** Fold everything currently live, e.g. at the end of an episode. */
  compact(): void {
    const folded = this.#turns.slice(
      0,
      Math.max(0, this.#turns.length - this.#keepRecent),
    );
    if (folded.length === 0) return;
    this.#turns = this.#turns.slice(folded.length);
    this.#chars = this.#turns.reduce((n, t) => n + t.text.length, 0);
    this.#folded += folded.length;
    this.#summary = this.#summarise(folded, this.#summary);
  }

  turns(): readonly Turn[] {
    return this.#turns;
  }

  summary(): string | undefined {
    return this.#summary;
  }

  /** How many turns have been folded away. Never silently lost, only condensed. */
  get foldedCount(): number {
    return this.#folded;
  }

  get liveChars(): number {
    return this.#chars;
  }

  learn(text: string, source?: string): Fact {
    const fact: Fact = {
      text,
      learnedAt: this.#clock.now(),
      ...(source === undefined ? {} : { source }),
    };
    this.#facts.push(fact);
    if (this.#facts.length > this.#maxFacts) {
      this.#facts = this.#facts.slice(this.#facts.length - this.#maxFacts);
    }
    return fact;
  }

  facts(): readonly Fact[] {
    return this.#facts;
  }

  /** Name a place. Re-naming an existing name replaces it. */
  remember(name: string, position: Vec3Like, note?: string): NamedLocation {
    const location: NamedLocation = {
      name,
      position,
      recordedAt: this.#clock.now(),
      ...(note === undefined ? {} : { note }),
    };
    this.#locations.set(name, location);
    return location;
  }

  location(name: string): NamedLocation | undefined {
    return this.#locations.get(name);
  }

  locations(): readonly NamedLocation[] {
    return [...this.#locations.values()];
  }

  forget(name: string): boolean {
    return this.#locations.delete(name);
  }

  snapshot(): MemorySnapshot {
    return {
      summary: this.#summary,
      turns: [...this.#turns],
      facts: [...this.#facts],
      locations: [...this.#locations.values()],
    };
  }

  /** Summary plus live turns, in the order they happened. */
  transcript(): string {
    const parts: string[] = [];
    if (this.#summary !== undefined) {
      parts.push(`== earlier (summarised) ==\n${this.#summary}`);
    }
    if (this.#turns.length > 0) {
      parts.push(
        `== recent ==\n${this.#turns.map((t) => `- ${t.role}: ${t.text}`).join('\n')}`,
      );
    }
    if (this.#facts.length > 0) {
      parts.push(
        `== learned ==\n${this.#facts.map((f) => `- ${f.text}`).join('\n')}`,
      );
    }
    if (this.#locations.size > 0) {
      parts.push(
        `== places ==\n${[...this.#locations.values()]
          .map(
            (l) =>
              `- ${l.name}: (${Math.round(l.position.x)},${Math.round(l.position.y)},${Math.round(l.position.z)})${l.note === undefined ? '' : `, ${l.note}`}`,
          )
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }

  /** Clears the episode. Facts and places survive unless `all` is set. */
  reset(all = false): void {
    this.#turns = [];
    this.#chars = 0;
    this.#summary = undefined;
    this.#folded = 0;
    if (all) {
      this.#facts = [];
      this.#locations = new Map();
    }
  }
}
