import type { AnySkill, Skill } from './types.js';

export class DuplicateSkill extends Error {
  constructor(readonly name: string) {
    super(`a skill named "${name}" is already registered`);
    this.name = 'DuplicateSkill';
  }
}

export class UnknownSkill extends Error {
  constructor(readonly skillName: string) {
    super(`no skill named "${skillName}" is registered`);
    this.name = 'UnknownSkill';
  }
}

/**
 * The set of skills a body can perform.
 *
 * Deliberately dumb: it stores and looks up. Timeouts, interrupts and
 * reliability accounting belong to the runner, and exposure as tools belongs
 * to the MCP layer, so that neither concern leaks in here.
 */
export class SkillRegistry {
  readonly #skills = new Map<string, AnySkill>();

  register<I, O>(skill: Skill<I, O>): this {
    if (this.#skills.has(skill.name)) throw new DuplicateSkill(skill.name);
    this.#skills.set(skill.name, skill as unknown as AnySkill);
    return this;
  }

  registerAll(skills: Iterable<AnySkill>): this {
    for (const s of skills) this.register(s);
    return this;
  }

  get(name: string): AnySkill | undefined {
    return this.#skills.get(name);
  }

  /** Like `get`, but throws rather than returning undefined. */
  require(name: string): AnySkill {
    const s = this.#skills.get(name);
    if (!s) throw new UnknownSkill(name);
    return s;
  }

  has(name: string): boolean {
    return this.#skills.has(name);
  }

  list(): readonly AnySkill[] {
    return [...this.#skills.values()];
  }

  names(): readonly string[] {
    return [...this.#skills.keys()].sort();
  }

  get size(): number {
    return this.#skills.size;
  }
}
