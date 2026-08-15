import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { CORE_SKILLS, registerCoreSkills } from '../../../src/skills/library/index.js';

describe('CORE_SKILLS', () => {
  it('registers cleanly and is reachable by name', () => {
    const registry = registerCoreSkills(new SkillRegistry());

    expect(registry.size).toBe(CORE_SKILLS.length);
    expect(registry.names()).toContain('goToBlock');
    expect(registry.names()).toContain('smeltItem');
    expect(registry.require('digBlock').name).toBe('digBlock');
  });

  it('has no duplicate names', () => {
    const names = CORE_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every skill well enough for an agent to choose between them', () => {
    for (const skill of CORE_SKILLS) {
      expect(skill.summary.length).toBeGreaterThan(10);
      // The description must say when *not* to reach for the skill; that is
      // the part an agent needs to avoid picking the wrong one.
      expect(skill.description.toLowerCase()).toContain('do not use');
      expect(skill.input).toBeDefined();
      expect(skill.output).toBeDefined();
    }
  });

  it('refuses to register the same set twice', () => {
    const registry = registerCoreSkills(new SkillRegistry());
    expect(() => registerCoreSkills(registry)).toThrow(/already registered/);
  });
});
