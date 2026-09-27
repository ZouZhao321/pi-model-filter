// 元数据来源与解析：从 npm 包的 markdown 文档（command-code 的 models.md）取
// cost、推理档位与上下文长度。解析只按来源声明给的列下标与解析器名干活。
// 三个值解析器都是纯函数，遇到不符合预期的写法就地抛出，错误带上原字符串。
import { ABORT_MESSAGE, cancelBody, fetchWithRetry, SourceError } from './retry.ts';
import type {
  MetadataCost,
  MetadataDeclaration,
  MetadataEntry,
  MetadataResult,
  MetadataSource,
  ProviderDeclaration,
  ValueParserName,
} from './types.ts';

function fail(message: string): never {
  throw new Error(message);
}

const NO_VALUE = new Set(['', '—']);

// size-suffix：1M -> 1000000，262K -> 262000，1.05M -> 1050000，纯数字原样，无值返回 undefined。
export function parseSizeSuffix(raw: string): number | undefined {
  const value = raw.trim();
  if (NO_VALUE.has(value)) return undefined;
  const match = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(value);
  if (!match) return fail(`无法解析 size-suffix 值：${raw}`);
  const number = Number(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') return Math.round(number * 1000);
  if (suffix === 'm') return Math.round(number * 1_000_000);
  return number;
}

// comma-list：high, max -> ["high","max"]，无值返回空数组。
export function parseCommaList(raw: string): string[] {
  const value = raw.trim();
  if (NO_VALUE.has(value)) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const PRICE_PATTERN =
  /^\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s*·\s*cache\s*\$(\d+(?:\.\d+)?)(?:\s*\(write\s*\$(\d+(?:\.\d+)?)\))?$/;

// price-slash-cache：$0.15/$0.6 · cache $0.003 -> {input:0.15,output:0.6,cacheRead:0.003}；
// 带 (write $0.5) 时多出 cacheWrite；无值返回 undefined。
export function parsePriceSlashCache(raw: string): MetadataCost | undefined {
  const value = raw.trim();
  if (NO_VALUE.has(value)) return undefined;
  const match = PRICE_PATTERN.exec(value);
  if (!match) return fail(`无法解析 price-slash-cache 值：${raw}`);
  const cost: MetadataCost = {
    input: Number(match[1]),
    output: Number(match[2]),
    cacheRead: Number(match[3]),
  };
  if (match[4] !== undefined) cost.cacheWrite = Number(match[4]);
  return cost;
}

const VALUE_PARSERS: Record<ValueParserName, (raw: string) => unknown> = {
  'size-suffix': parseSizeSuffix,
  'comma-list': parseCommaList,
  'price-slash-cache': parsePriceSlashCache,
};

function parseWith(parserName: ValueParserName, raw: string): unknown {
  const parser = VALUE_PARSERS[parserName];
  if (!parser) return fail(`不认识的解析器 ${parserName}`);
  return parser(raw);
}

function isSeparatorRow(row: string): boolean {
  return /^\|(?:\s*:?-+:?\s*\|)+$/.test(row);
}

function cellsOf(row: string): string[] {
  return row
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function stripBackticks(value: string): string {
  return value.replace(/^`|`$/g, '');
}

// 按 columns 与 valueParsers 把 markdown 文档解析成 Map<id, {name, contextWindow, thinkingLevel, cost}>。
// 表头行（分隔行的上一行）与 |---| 分隔行跳过；列下标与解析器名只来自声明，换一份声明结果就跟着变。
export function parseMetadataDocument(
  markdown: string,
  declaration: MetadataDeclaration,
): Map<string, MetadataEntry> {
  const tableRows: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) tableRows.push(trimmed);
  }

  const { columns, valueParsers } = declaration;
  const entries = new Map<string, MetadataEntry>();
  for (let index = 0; index < tableRows.length; index += 1) {
    const row = tableRows[index];
    if (isSeparatorRow(row)) continue;
    const next = tableRows[index + 1];
    if (next !== undefined && isSeparatorRow(next)) continue;
    const cells = cellsOf(row);
    const id = stripBackticks(cells[columns.id] ?? '');
    if (id.length === 0) continue;
    const name = cells[columns.name] ?? '';
    const contextWindow = parseWith(
      valueParsers.contextWindow,
      cells[columns.contextWindow] ?? '',
    ) as number | undefined;
    const thinkingLevel = (parseWith(
      valueParsers.thinkingLevel,
      cells[columns.thinkingLevel] ?? '',
    ) ?? []) as string[];
    const cost = parseWith(valueParsers.cost, cells[columns.cost] ?? '') as
      MetadataCost | undefined;
    entries.set(id, { name, contextWindow, thinkingLevel, cost });
  }
  return entries;
}

function toVersion(payload: unknown, attempts: number, status: number): string {
  try {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('registry 响应不是对象');
    }
    const version = (payload as { version?: unknown }).version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error('registry 响应里没有 version');
    }
    return version;
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error), attempts, status);
  }
}

// npm-package-doc：先取版本号，与缓存版本一致就跳过文档下载；不一致才取文件并解析。
// 所有失败路径都抛 SourceError，日志才能稳定拿到 attempts 与 status。
export function createNpmPackageDocSource(declaration: ProviderDeclaration): MetadataSource {
  const metadata = declaration.metadata;
  if (!metadata) throw new Error(`provider ${declaration.sourceProviderId} 没有声明 metadata`);
  const versionUrl = metadata.versionUrl.replaceAll('{package}', metadata.package);
  return {
    url: versionUrl,
    async fetchMetadata(signal: AbortSignal, cachedVersion?: string): Promise<MetadataResult> {
      const { response, attempts } = await fetchWithRetry(
        (requestSignal) => fetch(versionUrl, { signal: requestSignal }),
        signal,
      );
      if (!response.ok) {
        await cancelBody(response);
        throw new SourceError(`接口返回 HTTP ${response.status}`, attempts, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) throw new SourceError(ABORT_MESSAGE, attempts, response.status);
        throw new SourceError(
          `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          attempts,
          response.status,
        );
      }
      const version = toVersion(payload, attempts, response.status);
      if (version === cachedVersion) {
        return { version, entries: undefined, attempts };
      }

      const fileUrl = metadata.fileUrl
        .replaceAll('{package}', metadata.package)
        .replaceAll('{version}', version)
        .replaceAll('{file}', metadata.file);
      const fileResult = await fetchWithRetry(
        (requestSignal) => fetch(fileUrl, { signal: requestSignal }),
        signal,
      );
      if (!fileResult.response.ok) {
        await cancelBody(fileResult.response);
        throw new SourceError(
          `接口返回 HTTP ${fileResult.response.status}（${fileUrl}）`,
          fileResult.attempts,
          fileResult.response.status,
        );
      }
      let text: string;
      try {
        text = await fileResult.response.text();
      } catch (error) {
        if (signal.aborted) {
          throw new SourceError(ABORT_MESSAGE, fileResult.attempts, fileResult.response.status);
        }
        throw new SourceError(
          `文档下载失败（${fileUrl}）：${error instanceof Error ? error.message : String(error)}`,
          fileResult.attempts,
          fileResult.response.status,
        );
      }
      let entries: Map<string, MetadataEntry>;
      try {
        entries = parseMetadataDocument(text, metadata);
      } catch (error) {
        throw new SourceError(
          `文档解析失败（${fileUrl}）：${error instanceof Error ? error.message : String(error)}`,
          fileResult.attempts,
          fileResult.response.status,
        );
      }
      return { version, entries, attempts: attempts + fileResult.attempts };
    },
  };
}
