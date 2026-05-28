export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'rate_limited'
      | 'timeout'
      | 'invalid_request'
      | 'auth'
      | 'server_error'
      | 'unknown',
    public readonly httpStatus?: number,
    public readonly providerRaw?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'timeout' || this.code === 'server_error';
  }
}
