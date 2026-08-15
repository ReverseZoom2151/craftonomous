import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type {
  FailureKind,
  SkillContext,
  SkillResult,
} from '../skills/types.js';
import { isRetryable } from '../skills/types.js';
import type { SkillToolDefinition } from './schema.js';
import { describeSkillTool, unwrapArguments } from './schema.js';

/**
 * The narrow slice of a skill runner this layer needs.
 *
 * Declared structurally rather than imported so the MCP surface does not
 * depend on how skills are run — timeouts, interrupts and reliability
 * accounting are the runner's business, and the tool layer should not be able
 * to notice when they change.
 */
export interface SkillInvoker {
  run(
    name: string,
    input: unknown,
    ctx: SkillContext,
  ): Promise<SkillResult<unknown>>;
}

/** Builds the context a skill runs in, for one tool call. */
export type SkillContextFactory = (signal: AbortSignal) => SkillContext;

/**
 * MCP has two error channels and they are not interchangeable.
 *
 * A *protocol* error (a JSON-RPC error) says the request itself was wrong:
 * there is no such tool, the call was malformed. A model can rarely recover
 * from one. A *tool execution* error is an ordinary result carrying
 * `isError: true`, and clients are expected to feed it back to the model so it
 * can self-correct.
 *
 * Every `FailureKind` we produce is the second kind. A precondition that did
 * not hold, a target that could not be reached, a budget that ran out — these
 * are things that happened in the world, and an agent told about them can do
 * something next. Only "no skill by that name" is a protocol error, because
 * the agent asked for something this body does not have.
 */
/** What a successful tool call reports back. */
export interface ToolSuccessPayload {
  readonly ok: true;
  readonly skill: string;
  readonly value: unknown;
  readonly durationMs: number;
}

/**
 * What a failed tool call reports back.
 *
 * The failure kind and the retryable flag are the point. A tool result that
 * says only "it failed" leaves an agent with nothing to decide on; naming the
 * kind tells it whether to retry, re-plan, or ask for something else.
 */
export interface ToolFailurePayload {
  readonly ok: false;
  readonly skill: string;
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly message: string;
  readonly durationMs: number;
}

export type ToolPayload = ToolSuccessPayload | ToolFailurePayload;

function textResult(payload: ToolPayload, human: string): CallToolResult {
  return {
    content: [{ type: 'text', text: human }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: !payload.ok,
  };
}

/** Render a success as an MCP tool result carrying structured content. */
export function successResult(
  skill: string,
  value: unknown,
  durationMs: number,
): CallToolResult {
  const payload: ToolSuccessPayload = { ok: true, skill, value, durationMs };
  return textResult(payload, JSON.stringify(payload, null, 2));
}

/** Render a failure as an MCP error result that names its kind. */
export function failureResult(
  skill: string,
  kind: FailureKind,
  message: string,
  durationMs: number,
  retryable: boolean = isRetryable(kind),
): CallToolResult {
  const payload: ToolFailurePayload = {
    ok: false,
    skill,
    kind,
    retryable,
    message,
    durationMs,
  };
  const human =
    `${skill} failed: ${kind} ` +
    `(${retryable ? 'retryable' : 'not retryable'}) — ${message}\n` +
    JSON.stringify(payload, null, 2);
  return textResult(payload, human);
}

/** Map a skill result onto an MCP tool result. */
export function toCallToolResult(
  skill: string,
  result: SkillResult<unknown>,
): CallToolResult {
  return result.ok
    ? successResult(skill, result.value, result.durationMs)
    : failureResult(
        skill,
        result.kind,
        result.message,
        result.durationMs,
        result.retryable,
      );
}

/**
 * Every registered skill as an MCP tool definition, sorted by name.
 *
 * The order is deterministic on purpose: clients cache tool lists and models
 * cache the prompt prefix that contains them, and a list that reshuffles
 * between calls invalidates both for no reason.
 */
export function listTools(registry: SkillRegistry): readonly Tool[] {
  return registry
    .list()
    .map((skill) => describeSkillTool(skill).tool)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface ToolDispatcherOptions {
  readonly registry: SkillRegistry;
  readonly invoker: SkillInvoker;
  readonly context: SkillContextFactory;
}

/**
 * Turns `tools/list` and `tools/call` into skill lookups and invocations.
 *
 * Nothing here interprets the world: the dispatcher hands the skill layer an
 * input and hands the agent back what came out, including the shape of the
 * failure.
 */
export class ToolDispatcher {
  readonly #registry: SkillRegistry;
  readonly #invoker: SkillInvoker;
  readonly #context: SkillContextFactory;
  readonly #definitions = new Map<string, SkillToolDefinition>();

  constructor(options: ToolDispatcherOptions) {
    this.#registry = options.registry;
    this.#invoker = options.invoker;
    this.#context = options.context;
  }

  /** Tool definitions for the current registry contents, sorted by name. */
  list(): readonly Tool[] {
    const tools: Tool[] = [];
    for (const name of this.#registry.names()) {
      const definition = this.#define(name);
      if (definition) tools.push(definition.tool);
    }
    return tools;
  }

  #define(name: string): SkillToolDefinition | undefined {
    const cached = this.#definitions.get(name);
    if (cached) return cached;
    const skill = this.#registry.get(name);
    if (!skill) return undefined;
    const definition = describeSkillTool(skill);
    this.#definitions.set(name, definition);
    return definition;
  }

  /**
   * Invoke a skill by tool name.
   *
   * Skill failures come back as results with `isError: true` so the agent can
   * read the kind and decide. An unknown tool throws {@link McpError} instead:
   * that is a protocol error, not something that happened in the world.
   *
   * Rate limiting would sit here, in front of `invoker.run` — one place, on
   * the only path from an agent to an actuator. Nothing enforces a call budget
   * yet; a hostile or looping client can invoke as fast as the body responds.
   */
  async call(
    name: string,
    args: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CallToolResult> {
    const definition = this.#define(name);
    if (!definition) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `no skill named "${name}" is registered; call tools/list for what this body can do`,
      );
    }

    // Input validation itself belongs to the skill runner, which checks the
    // arguments against the skill's zod schema before anything acts.
    const input = unwrapArguments(definition, args);
    try {
      const result = await this.#invoker.run(name, input, this.#context(signal));
      return toCallToolResult(name, result);
    } catch (error) {
      // A throw from the runner is a bug or an abort, not a skill outcome. It
      // still comes back as a tool result so the agent can see it and adapt
      // rather than receiving a bare protocol error.
      const aborted = signal.aborted;
      return failureResult(
        name,
        aborted ? 'interrupted' : 'unknown',
        error instanceof Error ? error.message : String(error),
        0,
      );
    }
  }
}
