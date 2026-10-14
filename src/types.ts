// 跨模块共享的类型。目录与元数据来源都隔离在接口后面；
// 来源声明（provider 配置）是数据，字段名与地址全部来自 providers.json。
import type { ExtensionContext, ProviderModelConfig } from '@earendil-works/pi-coding-agent';

/** pi 要的字段 → 目录响应里对应的字段名。 */
export interface CatalogFields {
  id: string;
  name?: string;
  contextWindow?: string;
  endpoints?: string;
}

export type RequestHeaderValue = string | { generator: 'uuid' };

/** 目录来源声明：从哪里取、怎么取、怎么解析。 */
export interface CatalogDeclaration {
  kind: 'http-model-list';
  url: string;
  requestHeaders: Record<string, RequestHeaderValue>;
  authHeader: 'bearer' | undefined;
  envelope: 'openai-data-array';
  fields: CatalogFields;
}

/** 元数据文档里每一列对应的下标。 */
export interface MetadataFields {
  id: number;
  name: number;
  contextWindow: number;
  thinkingLevel: number;
  cost: number;
}

export type ValueParserName = 'size-suffix' | 'comma-list' | 'price-slash-cache';

/** 需要做值解析的列 -> 解析器名。id 与 name 按原样取字符串。 */
export interface MetadataValueParsers {
  contextWindow: ValueParserName;
  thinkingLevel: ValueParserName;
  cost: ValueParserName;
}

/** 元数据来源声明：从 npm 包文档或 pi 的 provider 模型列表取模型参数。 */
export type MetadataDeclaration =
  | {
      kind: 'npm-package-doc';
      package: string;
      file: string;
      versionUrl: string;
      fileUrl: string;
      format: 'markdown-table';
      columns: MetadataFields;
      valueParsers: MetadataValueParsers;
    }
  | {
      kind: 'pi-model-list';
    };

/** 一条模型元数据，键是模型 id。 */
export interface MetadataCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

export type MetadataEntry = Omit<Partial<ProviderModelConfig>, 'cost'> & {
  /** 元数据里的 cost 允许省略 cacheWrite，合并时补 0。 */
  cost?: MetadataCost;
  /** npm 文档使用的中间字段；合并时转换成 reasoning 与 thinkingLevelMap。 */
  thinkingLevel?: string[];
  [key: string]: unknown;
};

/** 元数据缓存：上一次成功解析得到的版本号与结果。 */
export interface MetadataCache {
  version: string;
  entries: Map<string, MetadataEntry>;
}

/** 参数补充表里一个模型 id 的补充字段。maxTokens 与 input 是补齐字段，其余字段按显式覆盖处理。 */
export interface ModelExtra {
  maxTokens?: number;
  input?: ('text' | 'image')[];
  [key: string]: unknown;
}

/** 一份校验过的 provider 定义。source 引用在解析时已经换成被引用方的声明，只有 name 可以按 provider 覆盖。 */
export interface ProviderDeclaration {
  /** 声明目录来源的 provider 名：凭据与目录缓存都按它取 */
  sourceProviderId: string;
  name: string;
  baseUrl?: string;
  api: string;
  compat?: ProviderModelConfig['compat'];
  catalog: CatalogDeclaration;
  metadata?: MetadataDeclaration;
  extras?: string;
  exclusions?: string;
}

/** 一条目录条目，字段名已经按来源声明换成 pi 的名字。 */
export interface CatalogEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  endpoints?: string[];
}

export interface CatalogResult {
  entries: CatalogEntry[];
  /** 实际发出的请求次数 */
  attempts: number;
}

/** 目录来源：外部环境只出现在这个接口的实现里，换数据源时整体替换。 */
export interface CatalogSource {
  /** 请求地址，只用于写日志 */
  readonly url: string;
  fetchEntries(signal: AbortSignal): Promise<CatalogResult>;
}

export type CatalogSourceFactory = (
  ctx: ExtensionContext,
  providerId: string,
  declaration: ProviderDeclaration,
) => CatalogSource;

/** 元数据获取结果。version 相同而跳过下载时 entries 为 undefined。 */
export interface MetadataResult {
  version: string;
  entries: Map<string, MetadataEntry> | undefined;
  /** 实际发出的请求次数 */
  attempts: number;
}

/** 元数据来源：外部环境只出现在这个接口的实现里，换数据源时整体替换。 */
export interface MetadataSource {
  /** 请求地址，只用于写日志 */
  readonly url: string;
  /** cachedVersion 与远端版本一致时跳过文档下载，返回 entries 为 undefined 的结果。 */
  fetchMetadata(signal: AbortSignal, cachedVersion?: string): Promise<MetadataResult>;
}

export type MetadataSourceFactory = (declaration: ProviderDeclaration) => MetadataSource;
