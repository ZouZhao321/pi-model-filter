// 配置与数据文件的读写。路径集中在这里。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProvidersConfig } from './providers.ts';
import type {
  CatalogEntry,
  MetadataCache,
  MetadataCost,
  MetadataEntry,
  ModelExtra,
  ProviderDeclaration,
} from './types.ts';

export const DATA_DIR = join(homedir(), '.pi', 'agent', 'model-filter');
const EXCLUDE_FILE = 'model-exclude.json';
const EXTRAS_FILE = 'model-extras.json';
export const PROVIDERS_PATH = join(DATA_DIR, 'providers.json');
export const LOG_PATH = join(DATA_DIR, 'requests.log');
export const REQUEST_TIMEOUT_MS = 10_000;

// 读一个 JSON 文件。读取失败或者不是合法 JSON 时就地抛出。
function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`${path} 读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// 排除表格式：provider 名 -> 要排除的模型 id 数组，按完整 id 精确匹配。
// 例：{ "opencode-go": ["glm-5.3", "kimi-k3"] }
// fileName 是来源声明里的排除表文件名，相对插件数据目录；省略时用默认的 model-exclude.json。
export function loadExcludes(fileName: string = EXCLUDE_FILE): Map<string, string[]> {
  const path = join(DATA_DIR, fileName);
  const excludes = new Map<string, string[]>();
  if (!existsSync(path)) return excludes;
  const parsed = readJsonFile(path);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层必须是一个对象：provider 名 -> 模型 id 数组`);
  }
  for (const [providerId, ids] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(ids)) {
      throw new Error(`${path} 里 ${providerId} 的值必须是字符串数组`);
    }
    const list = ids.map((id) => {
      if (typeof id !== 'string') {
        throw new Error(`${path} 里 ${providerId} 的数组只能放字符串`);
      }
      return id;
    });
    if (list.length > 0) excludes.set(providerId, list);
  }
  return excludes;
}

// 读 providers.json 里的来源声明。文件不存在时返回空表。
export function loadProviders(): Map<string, ProviderDeclaration> {
  if (!existsSync(PROVIDERS_PATH)) return new Map();
  return parseProvidersConfig(readJsonFile(PROVIDERS_PATH));
}

// 把一个模型 id 的补充字段对象转成 ModelExtra。maxTokens 必须是数字、input 必须是字符串数组，
// 其余字段按显式覆盖原样保留，不做类型校验。
function toModelExtra(
  fields: Record<string, unknown>,
  path: string,
  providerId: string,
  modelId: string,
): ModelExtra {
  const extra: ModelExtra = {};
  for (const [key, value] of Object.entries(fields)) {
    extra[key] = value;
  }
  if (
    extra.maxTokens !== undefined &&
    (typeof extra.maxTokens !== 'number' || !Number.isFinite(extra.maxTokens))
  ) {
    throw new Error(`${path} 里 provider ${providerId} 的模型 ${modelId} 的 maxTokens 必须是数字`);
  }
  if (
    extra.input !== undefined &&
    (!Array.isArray(extra.input) || !extra.input.every((item) => typeof item === 'string'))
  ) {
    throw new Error(
      `${path} 里 provider ${providerId} 的模型 ${modelId} 的 input 必须是字符串数组`,
    );
  }
  return extra;
}

// 参数补充表格式：provider 名 -> 模型 id -> 补充字段对象。文件不存在时视为空表。
// dataDir 只在测试里覆盖，用于隔离读写位置；默认仍是插件数据目录。
export function loadModelExtras(
  fileName: string = EXTRAS_FILE,
  dataDir: string = DATA_DIR,
): Map<string, Map<string, ModelExtra>> {
  const path = join(dataDir, fileName);
  const extras = new Map<string, Map<string, ModelExtra>>();
  if (!existsSync(path)) return extras;
  const parsed = readJsonFile(path);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层必须是一个对象：provider 名 -> 模型 id -> 补充字段`);
  }
  for (const [providerId, models] of Object.entries(parsed as Record<string, unknown>)) {
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new Error(`${path} 里 provider ${providerId} 的值必须是对象`);
    }
    const byId = new Map<string, ModelExtra>();
    for (const [modelId, fields] of Object.entries(models as Record<string, unknown>)) {
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error(`${path} 里 provider ${providerId} 的模型 ${modelId} 的值必须是对象`);
      }
      byId.set(
        modelId,
        toModelExtra(fields as Record<string, unknown>, path, providerId, modelId),
      );
    }
    extras.set(providerId, byId);
  }
  return extras;
}

interface CatalogCacheFile {
  provider: string;
  updatedAt: string;
  entries: CatalogEntry[];
}

// 目录缓存按 provider 分开存放。
export function catalogCachePath(providerId: string): string {
  return join(DATA_DIR, `catalog-${providerId}.json`);
}

function toCatalogEntry(value: unknown, path: string): CatalogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 里 entries 的每一项必须是对象`);
  }
  const record = value as Record<string, unknown>;
  const { id, name, contextWindow, endpoints } = record;
  if (typeof id !== 'string') throw new Error(`${path} 里 entries 的 id 必须是字符串`);
  if (name !== undefined && typeof name !== 'string') {
    throw new Error(`${path} 里 entries 的 name 必须是字符串`);
  }
  if (contextWindow !== undefined && typeof contextWindow !== 'number') {
    throw new Error(`${path} 里 entries 的 contextWindow 必须是数字`);
  }
  if (
    endpoints !== undefined &&
    (!Array.isArray(endpoints) || !endpoints.every((item) => typeof item === 'string'))
  ) {
    throw new Error(`${path} 里 entries 的 endpoints 必须是字符串数组`);
  }
  return {
    id,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(Array.isArray(endpoints) ? { endpoints: endpoints as string[] } : {}),
  };
}

// 读上一次拿到的目录条目。文件不存在时返回 undefined。
export function loadCatalogCache(providerId: string): CatalogEntry[] | undefined {
  const path = catalogCachePath(providerId);
  if (!existsSync(path)) return undefined;
  const parsed = readJsonFile(path);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层必须是一个对象`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${path} 里缺少 entries 数组`);
  }
  return entries.map((entry) => toCatalogEntry(entry, path));
}

export function saveCatalogCache(providerId: string, entries: readonly CatalogEntry[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const payload: CatalogCacheFile = {
    provider: providerId,
    updatedAt: new Date().toISOString(),
    entries: [...entries],
  };
  writeFileSync(catalogCachePath(providerId), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

// 元数据缓存按 provider 分开存放，文件里是「版本号 + 解析结果」。
export function metadataCachePath(providerId: string): string {
  return join(DATA_DIR, `metadata-${providerId}.json`);
}

function toMetadataCost(value: unknown, path: string): MetadataCost {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 里 metadata 的 cost 必须是对象`);
  }
  const record = value as Record<string, unknown>;
  const { input, output, cacheRead, cacheWrite } = record;
  if (typeof input !== 'number' || typeof output !== 'number' || typeof cacheRead !== 'number') {
    throw new Error(`${path} 里 metadata 的 cost 的 input、output、cacheRead 必须是数字`);
  }
  if (cacheWrite !== undefined && typeof cacheWrite !== 'number') {
    throw new Error(`${path} 里 metadata 的 cost 的 cacheWrite 必须是数字`);
  }
  return { input, output, cacheRead, cacheWrite: cacheWrite as number | undefined };
}

function toMetadataEntry(value: unknown, path: string): MetadataEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 里 metadata entries 的每一项必须是对象`);
  }
  const record = { ...(value as Record<string, unknown>) };
  if (record.thinkingLevel !== undefined) {
    if (
      !Array.isArray(record.thinkingLevel) ||
      !record.thinkingLevel.every((item) => typeof item === 'string')
    ) {
      throw new Error(`${path} 里 metadata entries 的 thinkingLevel 必须是字符串数组`);
    }
  }
  if (record.cost !== undefined) record.cost = toMetadataCost(record.cost, path);
  return record as MetadataEntry;
}

// 读上一次拿到的元数据。文件不存在时返回 undefined。
export function loadMetadataCache(providerId: string): MetadataCache | undefined {
  const path = metadataCachePath(providerId);
  if (!existsSync(path)) return undefined;
  const parsed = readJsonFile(path);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层必须是一个对象`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${path} 里缺少 version`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(`${path} 里 entries 必须是一个对象`);
  }
  const map = new Map<string, MetadataEntry>();
  for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
    map.set(id, toMetadataEntry(entry, path));
  }
  return { version, entries: map };
}

export function saveMetadataCache(
  providerId: string,
  version: string,
  entries: ReadonlyMap<string, MetadataEntry>,
): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const payload = {
    provider: providerId,
    version,
    updatedAt: new Date().toISOString(),
    entries: Object.fromEntries(entries),
  };
  writeFileSync(metadataCachePath(providerId), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}
