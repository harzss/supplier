import { describe, expect, it, vi } from 'vitest';
import type { ActivationService } from './activation.service';
import { ActivationController } from './activation.controller';

describe('ActivationController', () => {
  it('loads activation for the authenticated user', async () => {
    const get = vi.fn().mockResolvedValue({ currentStep: 'connect_shop' });
    const controller = new ActivationController({ get } as unknown as ActivationService);

    await expect(controller.getActivation({ userId: 42n, plan: 'free' })).resolves.toEqual({
      currentStep: 'connect_shop',
    });
    expect(get).toHaveBeenCalledWith(42n);
  });
});
