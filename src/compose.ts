// 注册与合并：旧路径的三层过滤与注册，以及新路径的合并函数。
// 旧路径：来源给的 id 里没有的丢弃，pi 列表里查不到元数据的丢弃，命中排除清单的丢弃。
// 新路径：目录条目里接口分组没有 /chat/completions 的丢弃，套排除表，其余字段按来源取值。
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';
import { PROVIDER_ID } from './config.ts';
import type {
  CatalogEntry,
  MetadataEntry,
  ModelExtra,
  ProviderDeclaration,
} from './types.ts';

const CHAT_COMPLETIONS_PATH = '/chat/completions';
// reasoning、cost、thinkingLevelMap 来自 npm 包的模型目录；maxTokens、input 来自参数补充表，
// 补充表没有的用默认值并记入待补列表。
const DEFAULT_MAX_TOKENS = 16_384;
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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

// 六个推理档位里出现的写档位本身，没出现的写 null。
function toThinkingLevelMap(levels: readonly string[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = levels.includes(level) ? level : null;
  }
  return map;
}

// 合并：目录条目 + provider 定义 + 排除表 + 元数据 + 参数补充表 -> pi 的模型定义数组。
// 保持目录里的先后次序；目录为空时返回空数组。自动取值顺序：contextWindow 以端点为准，
// cost、推理档位与 reasoning 来自元数据；maxTokens 与 input 来自补充表，没有就用默认值并记入待补列表。
// 补充表里显式写下的其余字段一律盖过任何自动来源（官方数据有误时的人工修正通道）。
export interface ComposeResult {
  models: ProviderModelConfig[];
  /** 待补 id：maxTokens 或 input 用了默认值的模型 id，按目录先后次序排列。 */
  pendingExtras: string[];
}

export function composeModels(
  declaration: ProviderDeclaration,
  entries: readonly CatalogEntry[],
  excludedIds: readonly string[],
  metadata?: ReadonlyMap<string, MetadataEntry>,
  extras?: ReadonlyMap<string, ModelExtra>,
): ComposeResult {
  const excluded = new Set(excludedIds);
  const pendingExtras: string[] = [];
  const models = entries
    .filter((entry) => entry.endpoints.includes(CHAT_COMPLETIONS_PATH) && !excluded.has(entry.id))
    .map((entry) => {
      const meta = metadata?.get(entry.id);
      const thinkingLevel = meta?.thinkingLevel ?? [];
      const metaCost = meta?.cost;
      const model: ProviderModelConfig = {
        id: entry.id,
        name: entry.name,
        api: declaration.api,
        baseUrl: declaration.baseUrl,
        reasoning: thinkingLevel.length > 0,
        thinkingLevelMap: toThinkingLevelMap(thinkingLevel),
        input: ['text'],
        cost: metaCost
          ? {
              input: metaCost.input,
              output: metaCost.output,
              cacheRead: metaCost.cacheRead,
              cacheWrite: metaCost.cacheWrite ?? 0,
            }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow,
        maxTokens: DEFAULT_MAX_TOKENS,
        compat: declaration.compat,
      };
      const extra = extras?.get(entry.id);
      if (typeof extra?.maxTokens !== 'number' || !Array.isArray(extra?.input)) {
        pendingExtras.push(entry.id);
      }
      if (extra) {
        if (typeof extra.maxTokens === 'number') model.maxTokens = extra.maxTokens;
        if (Array.isArray(extra.input)) model.input = [...extra.input];
        for (const [key, value] of Object.entries(extra)) {
          if (key === 'maxTokens' || key === 'input') continue;
          (model as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return model;
    });
  return { models, pendingExtras };
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
