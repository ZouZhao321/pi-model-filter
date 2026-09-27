// 跨模块共享的类型。名单来源是外部环境，隔离在 AvailableModelsSource 接口后面。
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

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
