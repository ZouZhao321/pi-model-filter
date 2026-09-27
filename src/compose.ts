// 注册与合并：旧路径的三层过滤与注册，以及新路径的合并函数。
// 旧路径：来源给的 id 里没有的丢弃，pi 列表里查不到元数据的丢弃，命中排除清单的丢弃。
// 新路径：目录条目里接口分组没有 /chat/completions 的丢弃，套排除表，其余字段按来源取值。
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID } from './config.ts';
import type { CatalogEntry, ProviderDeclaration } from './types.ts';

const CHAT_COMPLETIONS_PATH = '/chat/completions';
// reasoning、cost、maxTokens、input 暂时取固定值：T4 换成元数据来源，T5 换成补充表。
const DEFAULT_MAX_TOKENS = 16_384;

// 三层过滤：来源给的 id 里没有的丢弃，pi 列表里查不到元数据的丢弃，命中排除清单的丢弃。
export function selectModels<T extends { id: string }>(
  availableIds: readonly string[],
  providerModels: readonly T[],
  excludedIds: readonly string[],
): T[] {
  const available = new Set(availableIds);
  const excluded = new Set(excludedIds);
  return providerModels.filter((model) => available.has(model.id) && !excluded.has(model.id));
}

export function applyFilter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ids: readonly string[],
  excludedIds: readonly string[],
): void {
  const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
  if (!provider) return;
  const kept = selectModels(ids, provider.getModels(), excludedIds);
  pi.registerProvider(PROVIDER_ID, {
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: kept.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      samplingParams: model.samplingParams,
      compat: model.compat,
    })),
  });
}

// 合并：目录条目 + provider 定义 + 排除表 -> pi 的模型定义数组。
// 保持目录里的先后次序；目录为空时返回空数组。
export function composeModels(
  declaration: ProviderDeclaration,
  entries: readonly CatalogEntry[],
  excludedIds: readonly string[],
): ProviderModelConfig[] {
  const excluded = new Set(excludedIds);
  return entries
    .filter((entry) => entry.endpoints.includes(CHAT_COMPLETIONS_PATH) && !excluded.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      api: declaration.api,
      baseUrl: declaration.baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: DEFAULT_MAX_TOKENS,
      compat: declaration.compat,
    }));
}

// 把合并结果注册给 provider。提供 models 时 pi 是替换语义：该 provider 的模型列表以这一份为准。
export function registerCatalogModels(
  pi: ExtensionAPI,
  providerId: string,
  declaration: ProviderDeclaration,
  models: readonly ProviderModelConfig[],
): void {
  pi.registerProvider(providerId, {
    name: declaration.name,
    baseUrl: declaration.baseUrl,
    api: declaration.api,
    models: [...models],
  });
}
