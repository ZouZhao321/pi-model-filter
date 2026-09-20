// 按 model-exclude.json 的排除清单，从会话的模型列表里剔除指定模型。
//
// 为什么用扩展而不是 models.json：pi 解析 models.json 时是 upsert 语义
// （dist/core/provider-composer.js 的 applyModelsJson 先整份复制内置模型，
// 再按 id 覆盖或追加），没有任何删除入口；而扩展的 registerProvider 在
// 提供 models 时是替换语义（同文件 applyExtension：config.models 存在时
// 直接 map 返回，不保留原有条目）。
//
// 时机必须放在 session_start：factory 阶段拿到的内置目录不完整，还有一批
// 模型是运行期从远端目录刷新的，到 session_start 才齐。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'model-exclude.json');

// 配置格式：provider 名 -> 要排除的模型 id 数组，元素支持 * 通配符。
// 例：{ "opencode-go": ["grok-4.5", "muse-spark-*"] }
function loadExcludes(): Map<string, string[]> {
  const excludes = new Map<string, string[]>();
  if (!existsSync(CONFIG_PATH)) return excludes;
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8');
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} 的顶层必须是一个对象：provider 名 -> 模型 id 数组`);
  }
  for (const [providerId, patterns] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(patterns)) {
      throw new Error(`${CONFIG_PATH} 里 ${providerId} 的值必须是字符串数组`);
    }
    const list = patterns.map((pattern) => {
      if (typeof pattern !== 'string') {
        throw new Error(`${CONFIG_PATH} 里 ${providerId} 的数组只能放字符串`);
      }
      return pattern;
    });
    if (list.length > 0) excludes.set(providerId, list);
  }
  return excludes;
}

export function matches(pattern: string, modelId: string): boolean {
  if (!pattern.includes('*')) return pattern === modelId;
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(modelId);
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    for (const [providerId, patterns] of loadExcludes()) {
      const provider = ctx.modelRegistry.getProvider(providerId);
      if (!provider) continue;
      const all = provider.getModels();
      const kept = all.filter((model) => !patterns.some((pattern) => matches(pattern, model.id)));
      if (kept.length === all.length) continue;
      pi.registerProvider(providerId, {
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
          compat: model.compat,
        })),
      });
    }
  });
}
