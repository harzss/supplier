import { describe, expect, it, vi } from 'vitest';
import { LlmClient } from './client';
import { LlmError } from './errors';
import type { ChatOptions, ChatResult, LlmProvider } from './types';

function fakeProvider(behavior: () => Promise<ChatResult>): LlmProvider {
  return {
    supportedModels: ['deepseek-v3'],
    chat: vi.fn(behavior),
  };
}

function ok(): ChatResult {
  return {
    content: 'ok',
    model: 'deepseek-v3',
    usage: { inputTokens: 10, outputTokens: 5, costCny: 0.0001 },
  };
}

const opts: ChatOptions = {
  model: 'deepseek-v3',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('LlmClient', () => {
  it('throws when no provider is configured', async () => {
    const client = new LlmClient({ primary: new Map() });
    await expect(client.chat(opts)).rejects.toThrowError(/No provider/);
  });

  it('returns primary success', async () => {
    const provider = fakeProvider(async () => ok());
    const client = new LlmClient({
      primary: new Map([['deepseek-v3', provider]]),
    });
    const r = await client.chat(opts);
    expect(r.content).toBe('ok');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors then succeeds', async () => {
    let calls = 0;
    const provider = fakeProvider(async () => {
      calls++;
      if (calls < 2) throw new LlmError('429', 'rate_limited', 429);
      return ok();
    });
    const client = new LlmClient({
      primary: new Map([['deepseek-v3', provider]]),
      maxRetries: 2,
      retryBaseMs: 1,
    });
    const r = await client.chat(opts);
    expect(r.content).toBe('ok');
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('falls back to secondary on non-retryable error', async () => {
    const primary = fakeProvider(async () => {
      throw new LlmError('bad request', 'invalid_request', 400);
    });
    const fallback = fakeProvider(async () => ok());
    const client = new LlmClient({
      primary: new Map([['deepseek-v3', primary]]),
      fallback: new Map([['deepseek-v3', [fallback]]]),
      retryBaseMs: 1,
    });
    const r = await client.chat(opts);
    expect(r.content).toBe('ok');
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(fallback.chat).toHaveBeenCalledTimes(1);
  });

  it('emits events for observability', async () => {
    const provider = fakeProvider(async () => ok());
    const events: string[] = [];
    const client = new LlmClient({
      primary: new Map([['deepseek-v3', provider]]),
      onEvent: (e) => events.push(e.type),
    });
    await client.chat(opts);
    expect(events).toEqual(['attempt', 'success']);
  });
});
