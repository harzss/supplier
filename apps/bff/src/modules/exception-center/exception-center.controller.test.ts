import { describe, expect, it, vi } from 'vitest';
import { ExceptionCenterController } from './exception-center.controller';
import type { ExceptionCenterService } from './exception-center.service';

describe('ExceptionCenterController', () => {
  it('always derives tenant ownership from the authenticated user', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({ items: [] }),
      detail: vi.fn().mockResolvedValue({ id: '9' }),
      refresh: vi.fn().mockResolvedValue({ domains: {}, errors: [] }),
      acknowledge: vi.fn().mockResolvedValue({ id: '9', status: 'acknowledged' }),
    } as unknown as ExceptionCenterService;
    const controller = new ExceptionCenterController(service);
    const user = { userId: 42n, plan: 'free' as const };
    const query = { page: 1, pageSize: 30 };
    const dto = {
      expectedRevision: 2,
      clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
      note: '开始处理',
    };

    await controller.list(user, query);
    await controller.detail(user, '9');
    await controller.refresh(user);
    await controller.acknowledge(user, '9', dto);

    expect(service.list).toHaveBeenCalledWith(42n, query);
    expect(service.detail).toHaveBeenCalledWith(42n, '9');
    expect(service.refresh).toHaveBeenCalledWith(42n);
    expect(service.acknowledge).toHaveBeenCalledWith(42n, '9', dto);
  });
});
