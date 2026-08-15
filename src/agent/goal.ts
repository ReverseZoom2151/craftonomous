import type { Clock } from '../runtime/clock.js';

/**
 * A goal stack.
 *
 * Agents that keep a single "current task" string cannot decompose: the moment
 * mining iron requires first making a pickaxe, the original goal is overwritten
 * and never returns. A stack makes the sub-goal a first-class thing that pops
 * back to what it was serving.
 *
 * Resolution always carries a reason, and resolved goals go into a bounded
 * history, so at the end of a run the agent can say what it tried and why it
 * stopped instead of only reporting the last thing it happened to be doing.
 */

export type GoalStatus = 'active' | 'achieved' | 'abandoned';

export interface Goal {
  readonly id: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly createdAt: number;
  /** The goal this one was pushed to serve, if any. */
  readonly parentId?: string;
  readonly tags?: readonly string[];
  readonly resolvedAt?: number;
  /** Why it was achieved or abandoned. Required on resolution. */
  readonly reason?: string;
}

export interface PushOptions {
  readonly tags?: readonly string[];
}

export interface GoalStackOptions {
  readonly clock: Clock;
  /** Resolved goals retained. Default 64. */
  readonly historyLimit?: number;
  /** Refuse to push deeper than this. Default 16. */
  readonly maxDepth?: number;
}

export class GoalDepthExceeded extends Error {
  constructor(readonly maxDepth: number) {
    super(`goal stack is already ${maxDepth} deep; refusing to push further`);
    this.name = 'GoalDepthExceeded';
  }
}

export class GoalStack {
  readonly #clock: Clock;
  readonly #historyLimit: number;
  readonly #maxDepth: number;

  #stack: Goal[] = [];
  #history: Goal[] = [];
  #nextId = 1;

  constructor(options: GoalStackOptions) {
    this.#clock = options.clock;
    this.#historyLimit = Math.max(0, options.historyLimit ?? 64);
    this.#maxDepth = Math.max(1, options.maxDepth ?? 16);
  }

  push(description: string, options: PushOptions = {}): Goal {
    if (this.#stack.length >= this.#maxDepth) {
      throw new GoalDepthExceeded(this.#maxDepth);
    }
    const parent = this.current();
    const goal: Goal = {
      id: `g${this.#nextId++}`,
      description,
      status: 'active',
      createdAt: this.#clock.now(),
      ...(parent === undefined ? {} : { parentId: parent.id }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
    };
    this.#stack.push(goal);
    return goal;
  }

  /** The goal being worked on: the top of the stack. */
  current(): Goal | undefined {
    return this.#stack[this.#stack.length - 1];
  }

  /**
   * Remove the top goal without judging it. Prefer `achieve` or `abandon`:
   * a popped goal records no reason, which is exactly the information a run
   * report needs.
   */
  pop(): Goal | undefined {
    const goal = this.#stack.pop();
    if (goal) this.#record({ ...goal, status: 'abandoned', resolvedAt: this.#clock.now(), reason: 'popped without a reason' });
    return goal;
  }

  achieve(reason = 'achieved'): Goal | undefined {
    return this.#resolve('achieved', reason);
  }

  abandon(reason: string): Goal | undefined {
    return this.#resolve('abandoned', reason);
  }

  #resolve(status: 'achieved' | 'abandoned', reason: string): Goal | undefined {
    const goal = this.#stack.pop();
    if (!goal) return undefined;
    const resolved: Goal = {
      ...goal,
      status,
      resolvedAt: this.#clock.now(),
      reason,
    };
    this.#record(resolved);
    return resolved;
  }

  /** Abandon everything still on the stack, deepest last. */
  abandonAll(reason: string): readonly Goal[] {
    const out: Goal[] = [];
    while (this.#stack.length > 0) {
      const g = this.abandon(reason);
      if (g) out.push(g);
    }
    return out;
  }

  #record(goal: Goal): void {
    this.#history.push(goal);
    if (this.#history.length > this.#historyLimit) {
      this.#history = this.#history.slice(
        this.#history.length - this.#historyLimit,
      );
    }
  }

  /** Bottom-first: the root goal is index 0. */
  stack(): readonly Goal[] {
    return [...this.#stack];
  }

  /** Resolved goals, oldest first, bounded. */
  history(): readonly Goal[] {
    return [...this.#history];
  }

  get depth(): number {
    return this.#stack.length;
  }

  get isEmpty(): boolean {
    return this.#stack.length === 0;
  }

  /** A line per goal, for a prompt or a run report. */
  describe(): string {
    const lines: string[] = [];
    if (this.#stack.length === 0) {
      lines.push('no active goal');
    } else {
      this.#stack.forEach((g, i) => {
        lines.push(`${'  '.repeat(i)}${i === this.#stack.length - 1 ? '→' : '·'} ${g.description}`);
      });
    }
    if (this.#history.length > 0) {
      lines.push('previously:');
      for (const g of this.#history.slice(-5)) {
        lines.push(`  ${g.status}: ${g.description}${g.reason === undefined ? '' : ` (${g.reason})`}`);
      }
    }
    return lines.join('\n');
  }
}
