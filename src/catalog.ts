// http-model-list 目录来源与响应解析。解析只按来源声明给的字段映射处理数据。
import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ABORT_MESSAGE, cancelBody, fetchWithRetry, SourceError } from './retry.ts';
import type { CatalogDeclaration, CatalogEntry, CatalogSource, ProviderDeclaration } from './types.ts';

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
    const name = nameField === undefined ? undefined : record[nameField];
    const contextWindow = contextField === undefined ? undefined : record[contextField];
    const endpoints = endpointField === undefined ? undefined : record[endpointField];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (nameField !== undefined && typeof name !== 'string') continue;
    if (
      contextField !== undefined &&
      (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow))
    ) {
      continue;
    }
    if (
      endpointField !== undefined &&
      (!Array.isArray(endpoints) || !endpoints.every((item) => typeof item === 'string'))
    ) {
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(Array.isArray(endpoints) ? { endpoints: endpoints as string[] } : {}),
    });
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
  const provider = ctx.modelRegistry.getProvider(providerId);
  const modelBaseUrl = provider
    ?.getModels()
    .find((model) => model.api === 'openai-completions' && model.baseUrl)?.baseUrl;
  const baseUrl = declaration.baseUrl ?? provider?.baseUrl ?? modelBaseUrl;
  if (catalog.url.includes('{baseUrl}') && !baseUrl) {
    throw new Error(`provider ${providerId} 没有可用的 baseUrl`);
  }
  const url = catalog.url.replaceAll('{baseUrl}', baseUrl ?? '');
  return {
    url,
    async fetchEntries(signal) {
      const key =
        catalog.authHeader === 'bearer'
          ? await ctx.modelRegistry.getApiKeyForProvider(providerId)
          : undefined;
      if (catalog.authHeader === 'bearer' && !key) {
        throw new SourceError('没有可用的凭据', 0);
      }
      const { response, attempts } = await fetchWithRetry(
        (requestSignal) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(catalog.requestHeaders)) {
            headers[name] = typeof value === 'string' ? value : randomUUID();
          }
          if (key) headers.authorization = `Bearer ${key}`;
          return fetch(url, { headers, signal: requestSignal });
        },
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
