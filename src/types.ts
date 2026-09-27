// 跨模块共享的类型。名单来源与目录来源都是外部环境，各自隔离在一个接口后面；
// 来源声明（provider 配置）是数据，字段名与地址全部来自 providers.json。
import type { ExtensionContext, ProviderModelConfig } from '@earendil-works/pi-coding-agent';

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

/** pi 要的字段 → 目录响应里对应的字段名。 */
export interface CatalogFields {
  id: string;
  name: string;
  contextWindow: string;
  endpoints: string;
}

/** 目录来源声明：从哪里取、怎么取、怎么解析。 */
export interface CatalogDeclaration {
  kind: 'http-model-list';
  url: string;
  requestHeaders: Record<string, string>;
  authHeader: 'bearer' | undefined;
  envelope: 'openai-data-array';
  fields: CatalogFields;
}

/** 一份校验过的 provider 定义。source 引用在解析时已经换成被引用方的声明，只有 name 可以按 provider 覆盖。 */
export interface ProviderDeclaration {
  /** 声明目录来源的 provider 名：凭据与目录缓存都按它取 */
  sourceProviderId: string;
  name: string;
  baseUrl: string;
  api: string;
  compat?: ProviderModelConfig['compat'];
  catalog: CatalogDeclaration;
  extras?: string;
  exclusions?: string;
}

/** 一条目录条目，字段名已经按来源声明换成 pi 的名字。 */
export interface CatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
  endpoints: string[];
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
