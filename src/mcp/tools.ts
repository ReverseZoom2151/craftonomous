import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type {
  FailureKind,
  SkillContext,
  SkillResult,
} from '../skills/types.js';
import { isRetryable } from '../skills/types.js';
import type { RateLimitRefusal, RateLimiter } from './rate-limit.js';
import { describeRefusal } from './rate-limit.js';
import type { SkillToolDefinition } from './schema.js';
import { describeSkillTool, unwrapArguments } from './schema.js';

/**
 * The narrow slice of a skill runner this layer needs.
 *
 * Declared structurally rather than imported so the MCP surface does not
 * depend on how skills are run: timeouts, interrupts and reliability
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
 * not hold, a target that could not be reached, a budget that ran out: these
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
  /**
   * Present only when the failure carries a definite time to try again, which
   * today means a rate limit refusal. Optional rather than always present so
   * that every other failure keeps the payload shape it already had.
   */
  readonly retryAfterMs?: number;
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

function renderFailure(payload: ToolFailurePayload): CallToolResult {
  const human =
    `${payload.skill} failed: ${payload.kind} ` +
    `(${payload.retryable ? 'retryable' : 'not retryable'}): ` +
    `${payload.message}\n` +
    JSON.stringify(payload, null, 2);
  return textResult(payload, human);
}

/** Render a failure as an MCP error result that names its kind. */
export function failureResult(
  skill: string,
  kind: FailureKind,
  message: string,
  durationMs: number,
  retryable: boolean = isRetryable(kind),
): CallToolResult {
  return renderFailure({
    ok: false,
    skill,
    kind,
    retryable,
    message,
    durationMs,
  });
}

/**
 * Render a rate limit refusal as a tool *execution* error.
 *
 * `isError: true` on an ordinary result, never an {@link McpError}. The MCP
 * specification is explicit that execution errors are the ones a client feeds
 * back to the model, and being refused for going too fast is exactly the kind
 * of thing a model can correct on its own: it can wait the stated interval, or
 * do something else meanwhile. Raised as a JSON-RPC error it would surface as
 * a transport-level fault, and most clients would either retry it blindly or
 * tear down the session, both of which make things worse.
 *
 * ## On the failure kind
 *
 * `FailureKind` has no member for "you are going too fast", and `FailureKind`
 * lives in `src/skills/types.ts`, which this layer does not own. Rather than
 * invent one there, the refusal is reported as `unknown`, the kind whose
 * documented meaning is "everything else", with `retryable` forced to true.
 * That flag is the part an agent actually branches on, and a rate limit is the
 * most retryable failure there is: the only thing that has to change is the
 * clock. The message carries the specifics. If a `rate-limited` kind is ever
 * added to `FailureKind`, this is the single call site that should adopt it.
 */
export function rateLimitedResult(
  skill: string,
  refusal: RateLimitRefusal,
): CallToolResult {
  return renderFailure({
    ok: false,
    skill,
    kind: 'rate-limited',
    retryable: true,
    message: describeRefusal(refusal),
    durationMs: 0,
    retryAfterMs: refusal.retryAfterMs,
  });
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
  /**
   * Call budget enforced in front of every invocation. Omitted means no
   * budget, which is right for a dispatcher constructed directly in a test but
   * not for a served body; `createServer` supplies one by default.
   */
  readonly limiter?: RateLimiter | undefined;
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
  readonly #limiter: RateLimiter | undefined;
  readonly #definitions = new Map<string, SkillToolDefinition>();

  constructor(options: ToolDispatcherOptions) {
    this.#registry = options.registry;
    this.#invoker = options.invoker;
    this.#context = options.context;
    this.#limiter = options.limiter;
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
   * The call budget is enforced here, in front of `invoker.run`: one place, on
   * the only path from an agent to an actuator. A refusal is a result, not a
   * protocol error, for the reasons set out on {@link rateLimitedResult}.
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

    // Checked after the name is resolved and before anything is validated or
    // run. Ahead of the name check, a typo would burn budget the agent could
    // not have known it was spending; behind the invoker, the packets we are
    // trying not to send would already be gone.
    const decision = this.#limiter?.check(name);
    if (decision && !decision.allowed) {
      return rateLimitedResult(name, decision.refusal);
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
