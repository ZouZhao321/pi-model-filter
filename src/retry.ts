// 重试策略照抄 pi 自己的 fetchWithRetry（dist/utils/management-http.js）：
// 同一个超时预算内最多尝试 3 次，只对下面这些状态码与传输错误重试，
// 两次尝试之间不等待。
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const ABORT_MESSAGE = '请求已中止（超时或调用方取消）';

/** 名单请求失败。status 只在接口返回了 HTTP 状态码时存在。 */
export class SourceError extends Error {
  readonly attempts: number;
  readonly status: number | undefined;

  constructor(message: string, attempts: number, status?: number) {
    super(message);
    this.attempts = attempts;
    this.status = status;
  }
}

// 丢弃响应体。响应体本来就要丢弃，取消失败时无事可做，与 pi 的实现一致。
export async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 无事可做。
  }
}

// 带重试的请求：可重试的状态码，以及任何未被调用方取消的错误，都会再试一次
// （与 pi 的 fetchWithRetry 一致）；重试之前丢弃上一次的响应体。
// 所有失败路径都抛 SourceError，日志才能稳定拿到 attempts 与 status。
export async function fetchWithRetry(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<{ response: Response; attempts: number }> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (signal.aborted) throw new SourceError(ABORT_MESSAGE, attempts);
    try {
      const response = await doFetch(signal);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempts >= maxAttempts) {
        return { response, attempts };
      }
      await cancelBody(response);
    } catch (error) {
      if (signal.aborted) throw new SourceError(ABORT_MESSAGE, attempts);
      if (attempts >= maxAttempts) {
        throw new SourceError(error instanceof Error ? error.message : String(error), attempts);
      }
    }
  }
}
