// 配置与数据文件的读写。provider 常量与路径集中在这里。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROVIDER_ID = 'opencode-go';
export const DATA_DIR = join(homedir(), '.pi', 'agent', 'model-filter');
const EXCLUDE_PATH = join(DATA_DIR, 'model-exclude.json');
const AVAILABLE_PATH = join(DATA_DIR, 'available-models.json');
export const LOG_PATH = join(DATA_DIR, 'requests.log');
export const REQUEST_TIMEOUT_MS = 10_000;

// 配置格式：provider 名 -> 要排除的模型 id 数组，按完整 id 精确匹配。
// 例：{ "opencode-go": ["glm-5.3", "kimi-k3"] }
export function loadExcludes(): Map<string, string[]> {
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
export function loadAvailableIds(): string[] | undefined {
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

export function saveAvailableIds(ids: readonly string[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const payload: AvailableModelsFile = {
    provider: PROVIDER_ID,
    updatedAt: new Date().toISOString(),
    ids: [...ids],
  };
  writeFileSync(AVAILABLE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}
