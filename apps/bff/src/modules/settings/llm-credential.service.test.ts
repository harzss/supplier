import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { LlmCredentialService } from './llm-credential.service';
import type { AlertService } from '../observability/alert.service';

interface StoredCred {
  userId: bigint;
  provider: string;
  apiKeyEnc: string;
  label?: string | null;
  status: string;
  lastUsedAt: Date | null;
}

function makeService(opts: { fail?: boolean } = {}) {
  let stored: StoredCred | null = null;
  const prisma = {
    llmCredential: {
      upsert: async ({ create }: { create: StoredCred }) => {
        if (opts.fail) throw new Error('db down');
        stored = { lastUsedAt: null, ...create };
        return stored;
      },
      findUnique: async () => {
        if (opts.fail) throw new Error('db down');
        return stored;
      },
      deleteMany: async () => {
        if (opts.fail) throw new Error('db down');
        stored = null;
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const crypto = new CryptoService({ get: () => 'unit-test-key' } as unknown as ConfigService);
  const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
  return new LlmCredentialService(prisma, crypto, alerts);
}

describe('LlmCredentialService', () => {
  it('save stores encrypted key and returns masked view', async () => {
    const svc = makeService();
    const view = await svc.save(1n, 'deepseek', 'sk-1234567890abcdef');
    expect(view.configured).toBe(true);
    expect(view.usable).toBe(true);
    expect(view.provider).toBe('deepseek');
    expect(view.masked).toBe('sk-1****cdef');
  });

  it('get never returns plaintext', async () => {
    const svc = makeService();
    await svc.save(1n, 'openai', 'sk-secretsecret1234');
    const view = await svc.get(1n);
    expect(view.configured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-secretsecret1234');
    expect(view.masked).toContain('****');
  });

  it('resolve returns decrypted plaintext for internal use', async () => {
    const svc = makeService();
    await svc.save(1n, 'dashscope', 'sk-plaintext9876543');
    const resolved = await svc.resolve(1n);
    expect(resolved).toEqual({ provider: 'dashscope', apiKey: 'sk-plaintext9876543' });
  });

  it('get reports not configured when empty', async () => {
    const svc = makeService();
    expect(await svc.get(1n)).toEqual({ configured: false });
  });

  it('fails closed when credential state cannot be read or deleted', async () => {
    const svc = makeService({ fail: true });
    await expect(svc.resolve(1n)).rejects.toThrow('模型密钥服务暂时不可用');
    await expect(svc.get(1n)).rejects.toThrow('密钥状态读取失败');
    await expect(svc.remove(1n)).rejects.toThrow('密钥删除失败');
  });

  it('keeps a broken active credential visible but blocks platform fallback', async () => {
    const prisma = {
      llmCredential: {
        findUnique: vi.fn().mockResolvedValue({
          userId: 1n,
          provider: 'deepseek',
          apiKeyEnc: 'broken-ciphertext',
          status: 'active',
          lastUsedAt: null,
        }),
      },
    } as unknown as PrismaService;
    const crypto = {
      decrypt: vi.fn(() => {
        throw new Error('decrypt failed');
      }),
      mask: vi.fn(),
    } as unknown as CryptoService;
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const svc = new LlmCredentialService(prisma, crypto, alerts);

    await expect(svc.get(1n)).resolves.toMatchObject({
      configured: true,
      usable: false,
      provider: 'deepseek',
      masked: '****',
    });
    await expect(svc.resolve(1n)).rejects.toThrow('自有 API Key 无法解密');
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'credential.llm.decrypt.user.1', severity: 'critical' }),
    );
  });

  it('remove is idempotent', async () => {
    const svc = makeService();
    await svc.save(1n, 'openai', 'sk-1234567890abcdef');
    expect(await svc.remove(1n)).toEqual({ deleted: true });
    expect(await svc.get(1n)).toEqual({ configured: false });
  });
});
