// 配置与数据文件的读写。provider 常量与路径集中在这里。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProvidersConfig } from './providers.ts';
import type { CatalogEntry, ProviderDeclaration } from './types.ts';

export const PROVIDER_ID = 'opencode-go';
export const DATA_DIR = join(homedir(), '.pi', 'agent', 'model-filter');
const EXCLUDE_FILE = 'model-exclude.json';
const AVAILABLE_PATH = join(DATA_DIR, 'available-models.json');
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

interface AvailableModelsFile {
  provider: string;
  updatedAt: string;
  ids: string[];
}

// 读上一次从名单来源拿到的 id 名单。文件不存在时返回 undefined。
export function loadAvailableIds(): string[] | undefined {
  if (!existsSync(AVAILABLE_PATH)) return undefined;
  const parsed = readJsonFile(AVAILABLE_PATH);
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

export function saveAvailableIds(ids: readonly string[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const payload: AvailableModelsFile = {
    provider: PROVIDER_ID,
    updatedAt: new Date().toISOString(),
    ids: [...ids],
  };
  writeFileSync(AVAILABLE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

interface CatalogCacheFile {
  provider: string;
  updatedAt: string;
  entries: CatalogEntry[];
}

// 目录缓存按 provider 分开存放，不碰旧路径的 available-models.json。
export function catalogCachePath(providerId: string): string {
  return join(DATA_DIR, `catalog-${providerId}.json`);
}

function toCatalogEntry(value: unknown, path: string): CatalogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 里 entries 的每一项必须是对象`);
  }
  const record = value as Record<string, unknown>;
  const { id, name, contextWindow, endpoints } = record;
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new Error(`${path} 里 entries 的 id 与 name 必须是字符串`);
  }
  if (typeof contextWindow !== 'number') {
    throw new Error(`${path} 里 entries 的 contextWindow 必须是数字`);
  }
  if (!Array.isArray(endpoints) || !endpoints.every((item) => typeof item === 'string')) {
    throw new Error(`${path} 里 entries 的 endpoints 必须是字符串数组`);
  }
  return { id, name, contextWindow, endpoints };
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
