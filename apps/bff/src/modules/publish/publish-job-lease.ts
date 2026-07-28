export const PUBLISH_JOB_STALE_MS = 5 * 60_000;
export const PUBLISH_JOB_HEARTBEAT_MS = 60_000;

export interface PublishExecutionLease {
  assertOwned(): Promise<void>;
}

export class PublishJobLeaseError extends Error {
  constructor(
    readonly reason: 'lost' | 'unavailable',
    message: string,
    readonly leaseCause?: unknown,
  ) {
    super(message);
    this.name = 'PublishJobLeaseError';
  }
}

export function isPublishJobLeaseError(error: unknown): error is PublishJobLeaseError {
  return error instanceof PublishJobLeaseError;
}
