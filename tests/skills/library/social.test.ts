import { describe, expect, it } from 'vitest';
import { sendChat } from '../../../src/skills/library/social.js';
import { harness, precondition, refuse } from './harness.js';

describe('sendChat', () => {
  it('says something', async () => {
    const sent: string[] = [];
    const h = harness(
      {},
      {
        chat: (message) => {
          sent.push(message);
          return { ok: true };
        },
      },
    );
    const result = await sendChat.run(h.ctx, { message: 'heading to the mine' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.private).toBe(false);
    expect(sent).toEqual(['heading to the mine']);
  });

  it('whispers to one player', async () => {
    const sent: string[] = [];
    const h = harness(
      {},
      {
        chat: (message) => {
          sent.push(message);
          return { ok: true };
        },
      },
    );
    const result = await sendChat.run(h.ctx, { message: 'on my way', to: 'Steve' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.private).toBe(true);
    expect(sent).toEqual(['/msg Steve on my way']);
  });

  it('refuses to run server commands', async () => {
    // Chat is the one actuator that reaches the command surface. Letting a
    // planner get there by writing a sentence would make the perception
    // profile advisory.
    const h = harness();
    const check = await precondition(sendChat, h.ctx, { message: '/gamemode creative' });

    expect(check.holds).toBe(false);
    if (check.holds) return;
    expect(check.reason).toContain('server commands');
  });

  it('refuses a command even when the precondition is skipped', async () => {
    const h = harness();
    const result = await sendChat.run(h.ctx, { message: '  /op me' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('precondition');
    expect(h.body.calls).toHaveLength(0);
  });

  it('refuses whitespace', async () => {
    const h = harness();
    const check = await precondition(sendChat, h.ctx, { message: '   ' });
    expect(check.holds).toBe(false);
  });

  it('rejects an empty message at the schema', () => {
    expect(sendChat.input.safeParse({ message: '' }).success).toBe(false);
  });

  it('reports an actuator refusal', async () => {
    const h = harness({}, { chat: () => refuse('muted') });
    const result = await sendChat.run(h.ctx, { message: 'hello' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('muted');
  });

  it('bails when cancelled', async () => {
    const h = harness();
    h.controller.abort();
    const result = await sendChat.run(h.ctx, { message: 'hello' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('interrupted');
  });
});
