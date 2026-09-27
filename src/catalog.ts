// 目录来源与响应解析：opencode Go 的模型列表接口（旧路径），以及按来源声明取数的
// http-model-list（新路径）。两边的响应都解析成条目数组，解析只按来源声明给的字段映射干活。
import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID } from './config.ts';
import { ABORT_MESSAGE, cancelBody, fetchWithRetry, SourceError } from './retry.ts';
import type {
  AvailableModelsSource,
  CatalogDeclaration,
  CatalogEntry,
  CatalogSource,
  ProviderDeclaration,
} from './types.ts';

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

// 按来源声明给的字段映射解析目录条目。条目缺 id、名称、上下文长度或接口分组时跳过，
// 同一个 id 只留一次。响应不符合声明的封装形态（{ data: [...] }）时抛出。
export function parseCatalogEntries(payload: unknown, catalog: CatalogDeclaration): CatalogEntry[] {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('目录接口返回的结构里没有 data 数组');
  }
  const {
    id: idField,
    name: nameField,
    contextWindow: contextField,
    endpoints: endpointField,
  } = catalog.fields;
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const rawEntry of (payload as { data: unknown[] }).data) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const record = rawEntry as Record<string, unknown>;
    const id = record[idField];
    const name = record[nameField];
    const contextWindow = record[contextField];
    const endpoints = record[endpointField];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof name !== 'string') continue;
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow)) continue;
    if (!Array.isArray(endpoints) || !endpoints.every((item) => typeof item === 'string')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name, contextWindow, endpoints });
  }
  return entries;
}

// 结构不对时把解析错误也统一成 SourceError，日志才能拿到尝试次数与状态码。
export function toCatalogEntries(
  payload: unknown,
  catalog: CatalogDeclaration,
  attempts: number,
  status: number,
): CatalogEntry[] {
  try {
    return parseCatalogEntries(payload, catalog);
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error), attempts, status);
  }
}

// http-model-list：按来源声明发一次请求，把响应解析成目录条目。
// authHeader 为 bearer 时用 providerId 的凭据；取不到凭据按失败处理。
export function createHttpModelListSource(
  ctx: ExtensionContext,
  providerId: string,
  declaration: ProviderDeclaration,
): CatalogSource {
  const { catalog } = declaration;
  const url = catalog.url.replaceAll('{baseUrl}', declaration.baseUrl);
  return {
    url,
    async fetchEntries(signal) {
      const headers: Record<string, string> = { ...catalog.requestHeaders };
      if (catalog.authHeader === 'bearer') {
        const key = await ctx.modelRegistry.getApiKeyForProvider(providerId);
        if (!key) throw new SourceError('没有可用的凭据', 0);
        headers.authorization = `Bearer ${key}`;
      }
      const { response, attempts } = await fetchWithRetry(
        (requestSignal) => fetch(url, { headers, signal: requestSignal }),
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
      return {
        entries: toCatalogEntries(payload, catalog, attempts, response.status),
        attempts,
      };
    },
  };
}

// 默认名单来源：opencode Go 的模型列表接口。
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
