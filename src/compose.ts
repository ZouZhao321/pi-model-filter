// 三层过滤与注册：来源给的 id 里没有的丢弃，pi 列表里查不到元数据的丢弃，
// 命中排除清单的丢弃，然后把结果注册给 provider。
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID } from './config.ts';

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
