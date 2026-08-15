import type {
  Decision,
  Policy,
  PolicyInput,
  SkillDescriptor,
} from './policy.js';
import { describeOutcome, doneDecision } from './policy.js';

/**
 * A provider-agnostic language model seam.
 *
 * No SDK is imported and no request is made from this file. The reference agent
 * has to be runnable in CI with no network and no key, and an evaluation
 * substrate that hard-codes one vendor's client has quietly made the model part
 * of the apparatus. Callers inject whatever they like: an Anthropic client, an
 * Ollama loop, a canned transcript for a regression test.
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

/** A tool as advertised to a model that supports native tool calling. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

export interface LanguageModel {
  complete(
    messages: readonly LlmMessage[],
    tools?: readonly ToolSpec[],
  ): Promise<string>;
}

export function toolSpecs(
  skills: readonly SkillDescriptor[],
): readonly ToolSpec[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description ?? s.summary,
    ...(s.inputSchema === undefined ? {} : { inputSchema: s.inputSchema }),
  }));
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are controlling a character in Minecraft through a fixed set of skills.',
  '',
  'Every observation you are given is tagged with how it was obtained.',
  '- [seen], [heard], [felt] are current.',
  '- [remembered Xm ago] is a memory. The world may have moved on: the block',
  '  may be mined, the mob may have wandered off. Treat it as a lead to verify,',
  '  never as a present fact, and never claim to have found something you only',
  '  remember.',
  '- Anything absent from the observation is UNKNOWN, which is not the same as',
  '  absent from the world. If you need to know, go and look.',
  '',
  'Reply with exactly one JSON object and nothing else. One of:',
  '  {"kind":"skill","name":"<skill name>","input":{...}}',
  '  {"kind":"speak","text":"<what to say in chat>"}',
  '  {"kind":"done","reason":"<why you are stopping>"}',
].join('\n');

export interface PromptOptions {
  readonly systemPrompt?: string;
  /** Live turns of history to include. Default 12. */
  readonly maxTurns?: number;
}

/** Build the message list for one decision. Pure: no model is called. */
export function buildPrompt(
  input: PolicyInput,
  options: PromptOptions = {},
): readonly LlmMessage[] {
  const maxTurns = options.maxTurns ?? 12;
  const sections: string[] = [];

  sections.push(input.digest.text);

  const goalLines: string[] = [];
  if (input.goals.length === 0) {
    goalLines.push('no goal set');
  } else {
    input.goals.forEach((g, i) => {
      goalLines.push(
        `${i === input.goals.length - 1 ? 'CURRENT' : 'parent '} ${g.description}`,
      );
    });
  }
  sections.push(`== goals ==\n${goalLines.join('\n')}`);

  sections.push(
    `== skills ==\n${
      input.skills.length === 0
        ? 'none available'
        : input.skills
            .map((s) => `- ${s.name}: ${s.description ?? s.summary}`)
            .join('\n')
    }`,
  );

  const memory = input.memory;
  const memoryLines: string[] = [];
  if (memory.summary !== undefined) {
    memoryLines.push(`earlier (summarised):\n${memory.summary}`);
  }
  const recent = memory.turns.slice(-maxTurns);
  if (recent.length > 0) {
    memoryLines.push(
      `recent:\n${recent.map((t) => `- ${t.role}: ${t.text}`).join('\n')}`,
    );
  }
  if (memory.facts.length > 0) {
    memoryLines.push(
      `learned:\n${memory.facts.map((f) => `- ${f.text}`).join('\n')}`,
    );
  }
  if (memory.locations.length > 0) {
    memoryLines.push(
      `places:\n${memory.locations
        .map(
          (l) =>
            `- ${l.name}: (${Math.round(l.position.x)},${Math.round(l.position.y)},${Math.round(l.position.z)})`,
        )
        .join('\n')}`,
    );
  }
  if (memoryLines.length > 0) {
    sections.push(`== memory ==\n${memoryLines.join('\n\n')}`);
  }

  if (input.lastOutcome !== undefined) {
    sections.push(`== last step ==\n${describeOutcome(input.lastOutcome)}`);
  }

  sections.push(`== budget ==\nstep ${input.step + 1} of ${input.stepBudget}`);

  sections.push('Reply with one JSON decision object and nothing else.');

  return [
    { role: 'system', content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export interface ParseOptions {
  /** Used when nothing usable can be extracted. */
  readonly fallback?: Decision;
  /** When set, a skill name outside this list is rejected. */
  readonly knownSkills?: readonly string[];
}

/**
 * Pull a decision out of whatever the model actually said.
 *
 * This never throws. A malformed generation is a routine event, not an
 * exception: models emit prose around JSON, trailing commentary, fenced blocks,
 * and occasionally nothing usable at all. Throwing from here would turn a bad
 * sentence into a crashed run and lose the trace that explains it, so the
 * failure mode is a safe `done` carrying the reason.
 */
export function parseDecision(
  raw: string,
  options: ParseOptions = {},
): Decision {
  const fallback =
    options.fallback ??
    doneDecision('could not parse a decision from the model response');

  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;

  for (const candidate of jsonCandidates(raw)) {
    const decision = decisionFrom(candidate, options);
    if (decision) return decision;
  }
  return fallback;
}

/** Every balanced `{...}` run in the text, outermost first, fences stripped. */
function jsonCandidates(raw: string): readonly unknown[] {
  const text = raw.replace(/```(?:json)?/gi, '');
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
          } catch {
            // Not JSON after all; a later candidate may still parse.
          }
          i = j;
          break;
        }
      }
    }
    if (out.length >= 8) break;
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function decisionFrom(
  value: unknown,
  options: ParseOptions,
): Decision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const kind = (
    str(o['kind']) ??
    str(o['action']) ??
    str(o['type']) ??
    ''
  ).toLowerCase();

  // Tolerate the shapes models reach for unprompted.
  const name =
    str(o['name']) ?? str(o['skill']) ?? str(o['tool']) ?? str(o['skill_name']);
  const text = str(o['text']) ?? str(o['message']) ?? str(o['say']);
  const reason = str(o['reason']) ?? str(o['because']);

  const isSkill =
    kind === 'skill' || kind === 'tool' || kind === 'act' || kind === 'invoke';
  if (isSkill || (kind === '' && name !== undefined)) {
    if (name === undefined) return undefined;
    if (options.knownSkills && !options.knownSkills.includes(name)) {
      return undefined;
    }
    const inputRaw =
      o['input'] ?? o['arguments'] ?? o['args'] ?? o['parameters'] ?? {};
    const input =
      typeof inputRaw === 'object' && inputRaw !== null ? inputRaw : {};
    return { kind: 'skill', name, input };
  }

  if (kind === 'speak' || kind === 'say' || kind === 'chat') {
    return text === undefined ? undefined : { kind: 'speak', text };
  }

  if (kind === 'done' || kind === 'stop' || kind === 'finish') {
    return { kind: 'done', reason: reason ?? text ?? 'model reported done' };
  }

  if (kind === '' && text !== undefined) return { kind: 'speak', text };

  return undefined;
}

/* ------------------------------------------------------------------ */
/* LlmPolicy                                                           */
/* ------------------------------------------------------------------ */

export interface LlmPolicyOptions extends PromptOptions, ParseOptions {
  readonly model: LanguageModel;
  /** Advertise skills as native tools as well as in the prompt. Default true. */
  readonly advertiseTools?: boolean;
  /** Reject skill names outside the catalogue. Default true. */
  readonly restrictToCatalogue?: boolean;
  /** Called with every raw generation, for tracing. */
  readonly onResponse?: (raw: string) => void;
}

export class LlmPolicy implements Policy {
  readonly #options: LlmPolicyOptions;

  constructor(options: LlmPolicyOptions) {
    this.#options = options;
  }

  async decide(input: PolicyInput): Promise<Decision> {
    const promptOptions: PromptOptions = {
      ...(this.#options.systemPrompt === undefined
        ? {}
        : { systemPrompt: this.#options.systemPrompt }),
      ...(this.#options.maxTurns === undefined
        ? {}
        : { maxTurns: this.#options.maxTurns }),
    };
    const messages = buildPrompt(input, promptOptions);
    const tools =
      (this.#options.advertiseTools ?? true) && input.skills.length > 0
        ? toolSpecs(input.skills)
        : undefined;

    let raw: string;
    try {
      raw = await this.#options.model.complete(messages, tools);
    } catch (error) {
      // A provider outage should end the episode cleanly with a recorded
      // reason, not blow up the run and lose the trace.
      return doneDecision(`language model call failed: ${errorMessage(error)}`);
    }
    this.#options.onResponse?.(raw);

    const restrict = this.#options.restrictToCatalogue ?? true;
    const knownSkills =
      this.#options.knownSkills ??
      (restrict && input.skills.length > 0
        ? input.skills.map((s) => s.name)
        : undefined);

    return parseDecision(raw, {
      ...(this.#options.fallback === undefined
        ? {}
        : { fallback: this.#options.fallback }),
      ...(knownSkills === undefined ? {} : { knownSkills }),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
