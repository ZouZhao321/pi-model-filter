// 目录、元数据、参数补充表与排除表的合并和注册。
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
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
  const orderedEntries =
    declaration.metadata?.kind === 'pi-model-list' && metadata
      ? [...metadata.keys()]
          .filter((id) => entries.some((entry) => entry.id === id))
          .map((id) => entries.find((entry) => entry.id === id)!)
      : entries;
  const models = orderedEntries
    .filter(
      (entry) =>
        (entry.endpoints === undefined || entry.endpoints.includes(CHAT_COMPLETIONS_PATH)) &&
        !excluded.has(entry.id) &&
        (declaration.metadata?.kind !== 'pi-model-list' || metadata?.has(entry.id) === true),
    )
    .map((entry) => {
      const meta = metadata?.get(entry.id);
      const thinkingLevel = meta?.thinkingLevel ?? [];
      const model = {
        id: entry.id,
        name: entry.name ?? entry.id,
        api: declaration.api,
        ...(declaration.baseUrl === undefined ? {} : { baseUrl: declaration.baseUrl }),
        reasoning: thinkingLevel.length > 0,
        thinkingLevelMap: toThinkingLevelMap(thinkingLevel),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow ?? 0,
        maxTokens: DEFAULT_MAX_TOKENS,
        compat: declaration.compat,
        ...meta,
      } as ProviderModelConfig & { thinkingLevel?: string[] };
      delete model.thinkingLevel;
      if (meta?.cost) {
        model.cost = {
          input: meta.cost.input,
          output: meta.cost.output,
          cacheRead: meta.cost.cacheRead,
          cacheWrite: meta.cost.cacheWrite ?? 0,
        };
      }
      if (entry.name !== undefined) model.name = entry.name;
      if (entry.contextWindow !== undefined) model.contextWindow = entry.contextWindow;
      const extra = extras?.get(entry.id);
      if (
        (typeof extra?.maxTokens !== 'number' && typeof meta?.maxTokens !== 'number') ||
        (!Array.isArray(extra?.input) && !Array.isArray(meta?.input))
      ) {
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
    ...(declaration.baseUrl === undefined ? {} : { baseUrl: declaration.baseUrl }),
    api: declaration.api,
    models: [...models],
  });
}
