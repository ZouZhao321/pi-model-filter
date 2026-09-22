// 按 model-filter/model-exclude.json 的排除清单，从会话的模型列表里剔除指定模型。
//
// 列表来源分三层：先向 opencode 的模型接口要一份当前凭据可用的模型 id，
// 再到 pi 的模型列表里取元数据（取不到的丢弃），最后套排除清单。
//
// 为什么用扩展而不是 models.json：pi 解析 models.json 时是 upsert 语义
// （dist/core/provider-composer.js 的 applyModelsJson 先整份复制内置模型，
// 再按 id 覆盖或追加），没有任何删除入口；而扩展的 registerProvider 在
// 提供 models 时是替换语义（同文件 applyExtension：config.models 存在时
// 直接 map 返回，不保留原有条目）。
//
// 时机必须放在 session_start：factory 阶段拿到的内置目录不完整，还有一批
// 模型是运行期从远端目录刷新的，到 session_start 才齐。
//
// 请求是异步发起的，不挡住会话启动：启动时先用上次保存的名单注册一份，
// 请求成功后写入新名单并重新注册，失败则继续用保存的那份并记日志。
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const PROVIDER_ID = 'opencode-go';
const DATA_DIR = join(homedir(), '.pi', 'agent', 'model-filter');
const EXCLUDE_PATH = join(DATA_DIR, 'model-exclude.json');
const AVAILABLE_PATH = join(DATA_DIR, 'available-models.json');
const LOG_PATH = join(DATA_DIR, 'requests.log');
const REQUEST_TIMEOUT_MS = 10_000;

// 配置格式：provider 名 -> 要排除的模型 id 数组，元素支持 * 通配符。
// 例：{ "opencode-go": ["glm-5.3", "muse-spark-*"] }
function loadExcludes(): Map<string, string[]> {
  const excludes = new Map<string, string[]>();
  if (!existsSync(EXCLUDE_PATH)) return excludes;
  let raw: string;
  try {
    raw = readFileSync(EXCLUDE_PATH, 'utf-8');
  } catch (error) {
    throw new Error(
      `${EXCLUDE_PATH} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${EXCLUDE_PATH} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${EXCLUDE_PATH} 的顶层必须是一个对象：provider 名 -> 模型 id 数组`);
  }
  for (const [providerId, patterns] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(patterns)) {
      throw new Error(`${EXCLUDE_PATH} 里 ${providerId} 的值必须是字符串数组`);
    }
    const list = patterns.map((pattern) => {
      if (typeof pattern !== 'string') {
        throw new Error(`${EXCLUDE_PATH} 里 ${providerId} 的数组只能放字符串`);
      }
      return pattern;
    });
    if (list.length > 0) excludes.set(providerId, list);
  }
  return excludes;
}

interface AvailableModelsFile {
  provider: string;
  updatedAt: string;
  ids: string[];
}

// 读上一次从接口拿到的 id 名单。文件不存在时返回 undefined。
function loadAvailableIds(): string[] | undefined {
  if (!existsSync(AVAILABLE_PATH)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(AVAILABLE_PATH, 'utf-8');
  } catch (error) {
    throw new Error(
      `${AVAILABLE_PATH} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${AVAILABLE_PATH} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${AVAILABLE_PATH} 的顶层必须是一个对象`);
  }
  const ids = (parsed as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) {
    throw new Error(`${AVAILABLE_PATH} 里缺少 ids 数组`);
  }
  return ids.map((id) => {
    if (typeof id !== 'string') {
      throw new Error(`${AVAILABLE_PATH} 里 ids 只能放字符串`);
    }
    return id;
  });
}

function saveAvailableIds(ids: readonly string[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const payload: AvailableModelsFile = {
    provider: PROVIDER_ID,
    updatedAt: new Date().toISOString(),
    ids: [...ids],
  };
  writeFileSync(AVAILABLE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

interface RequestLogEntry {
  at: string;
  provider: string;
  url: string;
  outcome: 'success' | 'failure';
  durationMs: number;
  status?: number;
  idCount?: number;
  error?: string;
}

function appendLog(entry: RequestLogEntry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export function matches(pattern: string, modelId: string): boolean {
  if (!pattern.includes('*')) return pattern === modelId;
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(modelId);
}

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

// 三层过滤：接口给的 id 里没有的丢弃，pi 列表里查不到元数据的丢弃，命中排除清单的丢弃。
export function selectModels<T extends { id: string }>(
  availableIds: readonly string[],
  providerModels: readonly T[],
  patterns: readonly string[],
): T[] {
  const available = new Set(availableIds);
  return providerModels.filter(
    (model) => available.has(model.id) && !patterns.some((pattern) => matches(pattern, model.id)),
  );
}

function applyFilter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ids: readonly string[],
  patterns: readonly string[],
): void {
  const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
  if (!provider) return;
  const kept = selectModels(ids, provider.getModels(), patterns);
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

// 后台取一次名单。成功就写入文件并重新注册，失败就沿用已注册的那份并记日志。
async function refresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  patterns: readonly string[],
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined) return;
  const startedAt = Date.now();
  let url = '';
  try {
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
    url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    if (!key) {
      appendLog({
        at: new Date().toISOString(),
        provider: PROVIDER_ID,
        url,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        error: '没有可用的凭据',
      });
      return;
    }
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'x-opencode-session': randomUUID(),
        'x-opencode-client': 'pi',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      appendLog({
        at: new Date().toISOString(),
        provider: PROVIDER_ID,
        url,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        status: response.status,
        error: `接口返回 HTTP ${response.status}`,
      });
      return;
    }
    const ids = parseModelIds(await response.json());
    saveAvailableIds(ids);
    applyFilter(pi, ctx, ids, patterns);
    appendLog({
      at: new Date().toISOString(),
      provider: PROVIDER_ID,
      url,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      status: response.status,
      idCount: ids.length,
    });
  } catch (error) {
    appendLog({
      at: new Date().toISOString(),
      provider: PROVIDER_ID,
      url,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    const patterns = loadExcludes().get(PROVIDER_ID) ?? [];
    const saved = loadAvailableIds();
    if (saved) applyFilter(pi, ctx, saved, patterns);
    void refresh(pi, ctx, patterns);
  });
}
