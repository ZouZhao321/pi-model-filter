// 按 model-filter/model-exclude.json 的排除清单，从会话的模型列表里剔除指定模型。
//
// 列表来源分三层：先向名单来源要一份当前凭据可用的模型 id，再到 pi 的模型列表里
// 取元数据（取不到的丢弃），最后套排除清单。名单来源是外部环境，隔离在
// AvailableModelsSource 接口后面，默认实现走 opencode 接口，可以整体替换。
//
// 为什么用扩展而不是 models.json：opencode-go 是 pi 内置的 provider，pi 解析
// models.json 时对模型是 upsert 语义（dist/core/provider-composer.js 的
// applyModelsJson 先整份复制内置模型，再按 id 覆盖或追加），能加能改，没有删除
// 入口；而扩展的 registerProvider 在提供 models 时是替换语义（同文件
// applyExtension：config.models 存在时直接 map 返回，不保留原有条目），这是唯一
// 能真正缩减内置 provider 列表的方式。
//
// 时机必须放在 session_start：factory 阶段拿到的内置目录不完整，还有一批模型是
// 运行期从远端目录刷新的，到 session_start 才齐。
//
// 请求是异步发起的，不挡住会话启动：启动时先用上次保存的名单注册一份，
// 请求成功后写入新名单并重新注册，失败则继续用已注册的那份并记日志。
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

// 重试策略照抄 pi 自己的 fetchWithRetry（dist/utils/management-http.js）：
// 同一个超时预算内最多尝试 3 次，只对下面这些状态码与传输错误重试，
// 两次尝试之间不等待。
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface AvailableModelsResult {
  ids: string[];
  /** 实际发出的请求次数 */
  attempts: number;
}

/** 名单来源：外部环境只出现在这个接口的实现里，换数据源时整体替换。 */
export interface AvailableModelsSource {
  /** 请求地址，只用于写日志 */
  readonly url: string;
  fetchIds(signal: AbortSignal): Promise<AvailableModelsResult>;
}

export type SourceFactory = (ctx: ExtensionContext) => AvailableModelsSource;

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

// 带重试的请求。调用方取消是终态的；可重试的状态码会把响应体丢弃之后再试一次。
export async function fetchWithRetry(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<{ response: Response; attempts: number }> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    signal.throwIfAborted();
    try {
      const response = await doFetch(signal);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempts >= maxAttempts) {
        return { response, attempts };
      }
      try {
        await response.body?.cancel();
      } catch {
        // 响应体本来就要丢弃，取消失败时无事可做，与 pi 的实现一致。
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempts >= maxAttempts) {
        throw new SourceError(error instanceof Error ? error.message : String(error), attempts);
      }
    }
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
        throw new SourceError(`接口返回 HTTP ${response.status}`, attempts, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SourceError(
          `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          attempts,
          response.status,
        );
      }
      return { ids: parseModelIds(payload), attempts };
    },
  };
}

// 配置格式：provider 名 -> 要排除的模型 id 数组，按完整 id 精确匹配。
// 例：{ "opencode-go": ["glm-5.3", "kimi-k3"] }
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
  for (const [providerId, ids] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(ids)) {
      throw new Error(`${EXCLUDE_PATH} 里 ${providerId} 的值必须是字符串数组`);
    }
    const list = ids.map((id) => {
      if (typeof id !== 'string') {
        throw new Error(`${EXCLUDE_PATH} 里 ${providerId} 的数组只能放字符串`);
      }
      return id;
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

// 读上一次从名单来源拿到的 id 名单。文件不存在时返回 undefined。
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
  attempts?: number;
  status?: number;
  idCount?: number;
  error?: string;
}

function appendLog(entry: RequestLogEntry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
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

function applyFilter(
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

// 后台取一次名单。成功就写入文件并重新注册，失败就沿用已注册的那份并记日志。
export async function refresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  excludedIds: readonly string[],
  sourceFactory: SourceFactory = createOpencodeGoSource,
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined) return;
  const startedAt = Date.now();
  let url = '';
  try {
    const source = sourceFactory(ctx);
    url = source.url;
    const { ids, attempts } = await source.fetchIds(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    saveAvailableIds(ids);
    applyFilter(pi, ctx, ids, excludedIds);
    appendLog({
      at: new Date().toISOString(),
      provider: PROVIDER_ID,
      url,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      attempts,
      idCount: ids.length,
    });
  } catch (error) {
    appendLog({
      at: new Date().toISOString(),
      provider: PROVIDER_ID,
      url,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      attempts: error instanceof SourceError ? error.attempts : undefined,
      status: error instanceof SourceError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    const excludedIds = loadExcludes().get(PROVIDER_ID) ?? [];
    const saved = loadAvailableIds();
    if (saved) applyFilter(pi, ctx, saved, excludedIds);
    void refresh(pi, ctx, excludedIds);
  });
}
