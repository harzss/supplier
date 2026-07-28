/** 指数退避重试 */
export interface RetryOptions {
  maxRetries: number;
  baseMs: number;
  /** 返回 true 时才重试，默认所有错误都重试 */
  shouldRetry?: (err: unknown) => boolean;
  onAttempt?: (attempt: number, err: unknown) => void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : true;
      opts.onAttempt?.(attempt, err);
      if (!retryable || attempt >= opts.maxRetries) break;
      const delay = opts.baseMs * Math.pow(2, attempt) + Math.random() * 100;
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
