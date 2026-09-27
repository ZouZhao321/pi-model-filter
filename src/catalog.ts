// 名单来源：opencode Go 的模型列表接口，以及它的响应解析。
import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID } from './config.ts';
import { ABORT_MESSAGE, cancelBody, fetchWithRetry, SourceError } from './retry.ts';
import type { AvailableModelsSource } from './types.ts';

// 按 OpenAI 兼容格式取 data 数组里的 id：条目缺 id 的跳过，同一个 id 只留一次。
export function parseModelIds(payload: unknown): string[] {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('模型接口返回的结构里没有 data 数组');
  }
  const ids: string[] = [];
  for (const entry of (payload as { data: unknown[] }).data) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    ids.push(id);
  }
  return [...new Set(ids)];
}

// 结构不对时把解析错误也统一成 SourceError，日志才能拿到尝试次数与状态码。
export function toModelIds(payload: unknown, attempts: number, status: number): string[] {
  try {
    return parseModelIds(payload);
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error), attempts, status);
  }
}

// 默认来源：opencode Go 的模型列表接口。
export function createOpencodeGoSource(ctx: ExtensionContext): AvailableModelsSource {
  const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
  if (!provider) throw new Error(`找不到 provider ${PROVIDER_ID}`);
  // provider 级别不一定带 baseUrl。同一个 provider 下模型的地址会随接口类型不同
  // （opencode-go 的 anthropic-messages 模型用 /zen/go，openai-completions 模型
  // 用 /zen/go/v1），而模型列表接口是 OpenAI 兼容端点，所以取后者的地址。
  const baseUrl =
    provider.baseUrl ??
    provider.getModels().find((model) => model.api === 'openai-completions' && model.baseUrl)
      ?.baseUrl;
  if (!baseUrl) throw new Error(`provider ${PROVIDER_ID} 没有可用的 baseUrl`);
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  return {
    url,
    async fetchIds(signal) {
      const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!key) throw new SourceError('没有可用的凭据', 0);
      const { response, attempts } = await fetchWithRetry(
        (requestSignal) =>
          fetch(url, {
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${key}`,
              'x-opencode-session': randomUUID(),
              'x-opencode-client': 'pi',
            },
            signal: requestSignal,
          }),
        signal,
      );
      if (!response.ok) {
        await cancelBody(response);
        throw new SourceError(`接口返回 HTTP ${response.status}`, attempts, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) {
          throw new SourceError(ABORT_MESSAGE, attempts, response.status);
        }
        throw new SourceError(
          `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          attempts,
          response.status,
        );
      }
      return { ids: toModelIds(payload, attempts, response.status), attempts };
    },
  };
}
