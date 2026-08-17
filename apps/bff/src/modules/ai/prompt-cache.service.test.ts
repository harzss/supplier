import { describe, expect, it, vi } from 'vitest';
import type { RuntimeStateService } from '../../common/runtime-state.service';
import { PromptCacheService } from './prompt-cache.service';

describe('PromptCacheService', () => {
  it('reads and writes only through Supabase runtime state', async () => {
    const runtimeState = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ title: 'cached' })),
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeStateService;
    const cache = new PromptCacheService(runtimeState);

    const key = cache.buildKey('title', { source: '1688-1' });
    await expect(cache.get<{ title: string }>(key)).resolves.toEqual({ title: 'cached' });
    await expect(cache.set(key, { title: 'next' }, 60)).resolves.toBeUndefined();
    expect(runtimeState.store).toHaveBeenCalledWith(key, JSON.stringify({ title: 'next' }), 60_000);
  });

  it('treats Supabase failures as a cache miss without retaining local state', async () => {
    const runtimeState = {
      read: vi.fn().mockRejectedValue(new Error('database unavailable')),
      store: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as RuntimeStateService;
    const cache = new PromptCacheService(runtimeState);

    await expect(cache.set('ai:title:key', { title: 'not retained' }, 60)).resolves.toBeUndefined();
    await expect(cache.get('ai:title:key')).resolves.toBeNull();
    expect(runtimeState.read).toHaveBeenCalledTimes(1);
    expect(runtimeState.store).toHaveBeenCalledTimes(1);
  });
});
