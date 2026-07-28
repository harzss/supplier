import type { LlmClient } from '@supplier/llm-client';
import { describe, expect, it } from 'vitest';
import type { LlmCredentialService, ResolvedCredential } from '../settings/llm-credential.service';
import { LlmResolverService } from './llm-resolver.service';

function makeResolver(cred: ResolvedCredential | null) {
  const platform = { __tag: 'platform' } as unknown as LlmClient;
  const credentials = { resolve: async () => cred } as unknown as LlmCredentialService;
  return { resolver: new LlmResolverService(platform, credentials), platform };
}

describe('LlmResolverService', () => {
  it('falls back to platform client when no BYOK configured', async () => {
    const { resolver, platform } = makeResolver(null);
    const r = await resolver.resolve(1n);
    expect(r.viaByok).toBe(false);
    expect(r.client).toBe(platform);
    expect(r.pickModel('gpt-4o')).toBe('gpt-4o');
  });

  it('uses BYOK client and clamps unsupported model to a supported one', async () => {
    const { resolver } = makeResolver({ provider: 'deepseek', apiKey: 'sk-byok' });
    const r = await resolver.resolve(1n);
    expect(r.viaByok).toBe(true);
    expect(r.provider).toBe('deepseek');
    // deepseek 仅支持 deepseek-v3，gpt-4o 被钳制
    expect(r.pickModel('gpt-4o')).toBe('deepseek-v3');
    expect(r.pickModel('deepseek-v3')).toBe('deepseek-v3');
  });

  it('keeps a supported model for dashscope BYOK', async () => {
    const { resolver } = makeResolver({ provider: 'dashscope', apiKey: 'sk-byok' });
    const r = await resolver.resolve(1n);
    expect(r.viaByok).toBe(true);
    expect(r.pickModel('qwen-max')).toBe('qwen-max');
  });
});
