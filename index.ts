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
//
// 具体实现按职责分在 src/ 下：types 放共享类型，retry 放重试策略，catalog 放名单
// 来源与响应解析，compose 放过滤与注册，config 放路径与配置读写，log 放日志。
// 本文件只做编排。
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createOpencodeGoSource } from './src/catalog.ts';
import { applyFilter } from './src/compose.ts';
import {
  loadAvailableIds,
  loadExcludes,
  PROVIDER_ID,
  REQUEST_TIMEOUT_MS,
  saveAvailableIds,
} from './src/config.ts';
import { appendLog } from './src/log.ts';
import { SourceError } from './src/retry.ts';
import type { SourceFactory } from './src/types.ts';

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
