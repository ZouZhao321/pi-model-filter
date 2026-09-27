// 每次会话启动时维护每个 provider 的模型列表：先把上一次的目录缓存（连同元数据缓存）注册一份，
// 再在后台按来源声明请求目录与元数据，成功后写入新缓存并重新注册，失败则沿用已注册的那份并记日志。
// 引用同一个来源的 provider 共用一次请求与一份缓存，排除表按完整 id 精确匹配，
// 显示名各取自己声明里的那份（引用声明可以带 name 覆盖被引用方的显示名）。
//
// opencode-go 暂时走旧路径（T6 才迁移到来源声明）：向名单来源要一份当前凭据可用的模型 id，
// 再到 pi 的模型列表里取元数据（取不到的丢弃），最后套排除清单。名单来源是外部环境，
// 隔离在 AvailableModelsSource 接口后面，默认实现走 opencode 接口，可以整体替换。
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
// 请求是异步发起的，不挡住会话启动。离线（PI_OFFLINE）时不发请求，只用已注册的那份。
// print 模式下会话说完话就结束，请求可能晚于会话结束才回来；此时的响应仍然写缓存与日志，
// 但不调注册接口，因为 pi 已经把这一轮的 pi 与 ctx 判成失效。
//
// 具体实现按职责分在 src/ 下：types 放共享类型，retry 放重试策略，providers 放来源声明
// 校验，catalog 放目录来源与响应解析，metadata 放 npm 包文档的元数据来源与解析，
// compose 放合并与注册，config 放路径与配置读写，log 放日志。本文件只做编排。
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';
import { createHttpModelListSource, createOpencodeGoSource } from './src/catalog.ts';
import { applyFilter, composeModels, registerCatalogModels } from './src/compose.ts';
import {
  loadAvailableIds,
  loadCatalogCache,
  loadExcludes,
  loadMetadataCache,
  loadProviders,
  PROVIDER_ID,
  REQUEST_TIMEOUT_MS,
  saveAvailableIds,
  saveCatalogCache,
  saveMetadataCache,
} from './src/config.ts';
import { appendLog, type RequestLogEntry } from './src/log.ts';
import { createNpmPackageDocSource } from './src/metadata.ts';
import { SourceError } from './src/retry.ts';
import type {
  CatalogEntry,
  CatalogSourceFactory,
  MetadataCache,
  MetadataEntry,
  MetadataSourceFactory,
  ProviderDeclaration,
  SourceFactory,
} from './src/types.ts';

/** 会话状态：目录请求在后台进行，可能在会话结束之后才回来。 */
export interface SessionState {
  /** 会话是否已经结束（session_shutdown 之后）。结束时 pi 与 ctx 都已经失效。 */
  ended: boolean;
}

/** 请求回来之后的副作用。默认写真实缓存与日志，单元测试传入自己的实现。 */
export interface RefreshEffects {
  saveAvailableIds(ids: readonly string[]): void;
  saveCatalogCache(providerId: string, entries: readonly CatalogEntry[]): void;
  saveMetadataCache?(
    providerId: string,
    version: string,
    entries: ReadonlyMap<string, MetadataEntry>,
  ): void;
  loadMetadataCache?(providerId: string): MetadataCache | undefined;
  appendLog(entry: RequestLogEntry): void;
}

const DEFAULT_EFFECTS: RefreshEffects = {
  saveAvailableIds,
  saveCatalogCache,
  saveMetadataCache,
  loadMetadataCache,
  appendLog,
};

// 后台取一次名单。成功就写入文件并重新注册，失败就沿用已注册的那份并记日志。
// 会话已经结束时只写入文件与日志，跳过注册。
export async function refresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  excludedIds: readonly string[],
  session: SessionState,
  sourceFactory: SourceFactory = createOpencodeGoSource,
  effects: RefreshEffects = DEFAULT_EFFECTS,
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined) return;
  const startedAt = Date.now();
  let url = '';
  try {
    const source = sourceFactory(ctx);
    url = source.url;
    const { ids, attempts } = await source.fetchIds(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    effects.saveAvailableIds(ids);
    const registered = !session.ended;
    if (registered) applyFilter(pi, ctx, ids, excludedIds);
    effects.appendLog({
      at: new Date().toISOString(),
      provider: PROVIDER_ID,
      url,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      attempts,
      idCount: ids.length,
      registered,
    });
  } catch (error) {
    effects.appendLog({
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

// 取一次元数据：版本与缓存一致时跳过下载，不一致时下载并解析。
// 成功时写缓存并返回新结果；失败时沿用上一次缓存并写一条失败日志，没有缓存就返回 undefined。
async function fetchMetadataForComposition(
  sourceProviderId: string,
  declaration: ProviderDeclaration,
  sourceFactory: MetadataSourceFactory,
  effects: RefreshEffects,
): Promise<Map<string, MetadataEntry> | undefined> {
  const cached = effects.loadMetadataCache?.(sourceProviderId);
  const source = sourceFactory(declaration);
  const startedAt = Date.now();
  try {
    const { version, entries } = await source.fetchMetadata(
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cached?.version,
    );
    if (entries) {
      (effects.saveMetadataCache ?? saveMetadataCache)(sourceProviderId, version, entries);
      return entries;
    }
    return cached?.entries;
  } catch (error) {
    effects.appendLog({
      at: new Date().toISOString(),
      provider: sourceProviderId,
      url: source.url,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      attempts: error instanceof SourceError ? error.attempts : undefined,
      status: error instanceof SourceError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return cached?.entries;
  }
}

// 后台取一次目录。成功就写入缓存并重新注册，失败就沿用已注册的那份并记日志。
// 声明了 metadata 的 provider 还会在同一轮里刷新元数据：元数据失败只影响参数，不影响目录。
// 会话已经结束时只写入缓存与日志，跳过注册。
export async function refreshCatalog(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  providers: readonly ProviderRef[],
  declaration: ProviderDeclaration,
  excludedIds: readonly string[],
  session: SessionState,
  sourceFactory: CatalogSourceFactory = createHttpModelListSource,
  effects: RefreshEffects = DEFAULT_EFFECTS,
  metadataSourceFactory: MetadataSourceFactory = createNpmPackageDocSource,
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined) return;
  const startedAt = Date.now();
  const sourceProviderId = declaration.sourceProviderId;
  let url = '';
  try {
    const source = sourceFactory(ctx, sourceProviderId, declaration);
    url = source.url;
    const { entries, attempts } = await source.fetchEntries(
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    effects.saveCatalogCache(sourceProviderId, entries);

    const metadataEntries = declaration.metadata
      ? await fetchMetadataForComposition(
          sourceProviderId,
          declaration,
          metadataSourceFactory,
          effects,
        )
      : undefined;

    const registered = !session.ended;
    if (registered)
      registerCatalog(
        pi,
        providers,
        composeModels(declaration, entries, excludedIds, metadataEntries),
      );
    effects.appendLog({
      at: new Date().toISOString(),
      provider: sourceProviderId,
      url,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      attempts,
      idCount: entries.length,
      registered,
    });
  } catch (error) {
    effects.appendLog({
      at: new Date().toISOString(),
      provider: sourceProviderId,
      url,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      attempts: error instanceof SourceError ? error.attempts : undefined,
      status: error instanceof SourceError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 把同一份模型定义注册给引用同一个来源的每个 provider。显示名取各自声明里的那份。
function registerCatalog(
  pi: ExtensionAPI,
  providers: readonly ProviderRef[],
  models: readonly ProviderModelConfig[],
): void {
  for (const { providerId, declaration } of providers) {
    registerCatalogModels(pi, providerId, declaration, models);
  }
}

export interface ProviderRef {
  providerId: string;
  declaration: ProviderDeclaration;
}

interface SourceGroup {
  declaration: ProviderDeclaration;
  providers: ProviderRef[];
}

// 引用同一个来源的 provider 归成一组：一份缓存、一次请求、一次合并。
function groupBySource(providers: Map<string, ProviderDeclaration>): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const [providerId, declaration] of providers) {
    const group = groups.get(declaration.sourceProviderId);
    if (group) {
      group.providers.push({ providerId, declaration });
    } else {
      groups.set(declaration.sourceProviderId, {
        declaration,
        providers: [{ providerId, declaration }],
      });
    }
  }
  return [...groups.values()];
}

export default function (pi: ExtensionAPI) {
  const session: SessionState = { ended: false };

  // 会话结束之后到达的响应只能写缓存与日志，不能再调注册接口。
  pi.on('session_shutdown', () => {
    session.ended = true;
  });

  pi.on('session_start', (_event, ctx) => {
    session.ended = false;

    // opencode-go 的旧路径（T6 才迁移到来源声明）
    const excludes = loadExcludes();
    const excludedIds = excludes.get(PROVIDER_ID) ?? [];
    const saved = loadAvailableIds();
    if (saved) applyFilter(pi, ctx, saved, excludedIds);
    void refresh(pi, ctx, excludedIds, session);

    // providers.json 里声明过的 provider
    for (const { declaration, providers } of groupBySource(loadProviders())) {
      const catalogExcludedIds = declaration.exclusions
        ? (loadExcludes(declaration.exclusions).get(declaration.sourceProviderId) ?? [])
        : [];
      const cached = loadCatalogCache(declaration.sourceProviderId);
      if (cached) {
        const metadataEntries = declaration.metadata
          ? loadMetadataCache(declaration.sourceProviderId)?.entries
          : undefined;
        registerCatalog(
          pi,
          providers,
          composeModels(declaration, cached, catalogExcludedIds, metadataEntries),
        );
      }
      void refreshCatalog(pi, ctx, providers, declaration, catalogExcludedIds, session);
    }
  });
}
