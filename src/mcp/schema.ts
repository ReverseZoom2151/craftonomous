import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import type { ZodSchema } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AnySkill } from '../skills/types.js';

/**
 * The root schema shape MCP requires of a tool: a JSON Schema object, with
 * anything else allowed alongside.
 */
export type ToolInputSchema = Tool['inputSchema'];

/**
 * Where a non-object input schema is carried.
 *
 * MCP requires a tool's `inputSchema` to be an object at the root. A skill is
 * free to take a bare string or a tuple, so those get wrapped under one
 * property rather than being quietly mangled into something they are not. The
 * dispatcher unwraps the same key on the way back in, so the round trip is
 * lossless and stated in one place.
 */
export const WRAPPED_ARGUMENT_KEY = 'value';

/** Conversion settings kept in one place so every tool is described alike. */
const CONVERSION = {
  // Inline everything. An agent reading a tool list should not have to chase a
  // $ref into a definitions block it was never sent.
  $refStrategy: 'none',
} as const;

/**
 * What MCP permits in a tool name: 1-128 characters, case-sensitive, drawn
 * from `A-Za-z0-9_.-`. No spaces. Checked rather than assumed, because a name
 * that fails this is rejected by the client and the skill simply never appears.
 */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export class InvalidToolName extends Error {
  constructor(readonly skillName: string) {
    super(
      `skill name ${JSON.stringify(skillName)} is not a legal MCP tool name: ` +
        'expected 1-128 characters from A-Za-z0-9_.- with no spaces',
    );
    this.name = 'InvalidToolName';
  }
}

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

/** Convert a zod schema to JSON Schema, with no `$schema` or `definitions`. */
export function toJsonSchema(
  schema: ZodType<unknown>,
): Record<string, unknown> {
  const converted = zodToJsonSchema(
    schema as unknown as ZodSchema<unknown>,
    CONVERSION,
  ) as Record<string, unknown>;
  const { $schema: _schema, definitions: _definitions, ...rest } = converted;
  return rest;
}

/** True when a converted schema is already an object at its root. */
export function isObjectSchema(
  schema: Record<string, unknown>,
): schema is ToolInputSchema {
  return schema['type'] === 'object';
}

/**
 * The description an agent reads when choosing between skills.
 *
 * Summary and description are joined rather than one being picked, because the
 * summary says what the skill does and the description says when *not* to use
 * it, and an agent choosing without the second half chooses badly.
 */
export function describeSkill(skill: AnySkill): string {
  const summary = skill.summary.trim();
  const description = skill.description.trim();
  if (description === '' || description === summary) return summary;
  if (summary === '') return description;
  return `${summary}\n\n${description}`;
}

/** A tool definition, plus how its arguments were shaped to fit MCP. */
export interface SkillToolDefinition {
  readonly tool: Tool;
  /**
   * True when the skill's input was not an object at its root and so travels
   * under {@link WRAPPED_ARGUMENT_KEY}.
   */
  readonly wrapsArguments: boolean;
}

/**
 * Describe a skill as an MCP tool, recording whether arguments are wrapped.
 *
 * No `outputSchema` is declared. MCP requires that a tool declaring one return
 * `structuredContent` conforming to it, and our structured content is a result
 * envelope, `{ ok, skill, value | kind, retryable, durationMs }`, not the
 * skill's own output type. Declaring the skill's output schema here would make
 * every failure a schema violation. The envelope is documented in `tools.ts`
 * instead; when MCP gains a way to describe a discriminated result, this is
 * where the declaration goes.
 */
export function describeSkillTool(skill: AnySkill): SkillToolDefinition {
  if (!isValidToolName(skill.name)) throw new InvalidToolName(skill.name);

  const converted = toJsonSchema(skill.input as unknown as ZodType<unknown>);
  const description = describeSkill(skill);

  if (isObjectSchema(converted)) {
    return {
      tool: {
        name: skill.name,
        description,
        // A no-argument skill converts to a bare `{ type: 'object' }`; MCP
        // wants a usable schema, so say plainly that nothing is accepted.
        inputSchema:
          converted['properties'] === undefined
            ? { ...converted, properties: {}, additionalProperties: false }
            : converted,
      },
      wrapsArguments: false,
    };
  }

  const wrapped: ToolInputSchema = {
    type: 'object',
    properties: { [WRAPPED_ARGUMENT_KEY]: converted as object },
    required: [WRAPPED_ARGUMENT_KEY],
    additionalProperties: false,
  };
  return {
    tool: { name: skill.name, description, inputSchema: wrapped },
    wrapsArguments: true,
  };
}

/** The MCP tool definition for a skill. */
export function toolDefinition(skill: AnySkill): Tool {
  return describeSkillTool(skill).tool;
}

/**
 * Recover the input a skill expects from the arguments MCP delivered.
 *
 * Undefined arguments become an empty object so that a skill taking no input
 * still validates, rather than failing on `undefined` when nothing was needed.
 */
export function unwrapArguments(
  definition: SkillToolDefinition,
  args: unknown,
): unknown {
  if (!definition.wrapsArguments) return args ?? {};
  if (args !== null && typeof args === 'object') {
    return (args as Record<string, unknown>)[WRAPPED_ARGUMENT_KEY];
  }
  return args;
}
