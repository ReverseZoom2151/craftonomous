import { z } from 'zod';
import type { Skill } from '../types.js';
import { HOLDS, fail, fails, succeed } from '../types.js';
import { guarded, interruptCheck } from './support.js';

const sendChatInput = z.object({
  /** What to say. Minecraft truncates well past 256 characters. */
  message: z.string().min(1).max(256),
  /** Username to whisper to. Omitted broadcasts to the server. */
  to: z.string().min(1).max(16).optional(),
});
const sendChatOutput = z.object({
  message: z.string(),
  private: z.boolean(),
});

export type SendChatInput = z.infer<typeof sendChatInput>;
export type SendChatOutput = z.infer<typeof sendChatOutput>;

export const sendChat: Skill<SendChatInput, SendChatOutput> = {
  name: 'sendChat',
  summary: 'Say something in chat, or whisper it to one player.',
  description: [
    'Sends a chat message, optionally as a whisper via `/msg`.',
    'A message beginning with `/` is refused by the precondition. Chat is the',
    'one actuator that can run arbitrary server commands, and letting a',
    'planner reach that surface by writing a sentence would make every',
    'perception guarantee in this system negotiable.',
    'Nothing here waits for or guarantees a reply, so do not use it as a',
    'request-response channel, and do not use it to talk to yourself: it is a',
    'visible action other players see, not a scratchpad.',
  ].join(' '),
  input: sendChatInput,
  output: sendChatOutput,
  precondition: (_ctx, input) => {
    const text = input.message.trim();
    if (text.length === 0) return Promise.resolve(fails('the message is only whitespace'));
    if (text.startsWith('/')) {
      return Promise.resolve(
        fails('chat may not be used to run server commands; use a dedicated skill'),
      );
    }
    return Promise.resolve(HOLDS);
  },
  run: (ctx, input) =>
    guarded(ctx, async (elapsed) => {
      const interrupted = interruptCheck<SendChatOutput>(ctx, elapsed, 'before speaking');
      if (interrupted) return interrupted;

      const text = input.message.trim();
      if (text.startsWith('/')) {
        return fail(
          'precondition',
          'chat may not be used to run server commands',
          elapsed(),
        );
      }
      const line = input.to === undefined ? text : `/msg ${input.to} ${text}`;
      const outcome = await ctx.act.chat(line);
      if (!outcome.ok) {
        return fail(
          'unknown',
          `could not send the message: ${outcome.detail ?? 'no detail given'}`,
          elapsed(),
        );
      }
      return succeed({ message: text, private: input.to !== undefined }, elapsed());
    }),
};
