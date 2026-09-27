// 请求日志：每行一条 JSON，追加写入。
import { appendFileSync, mkdirSync } from 'node:fs';
import { DATA_DIR, LOG_PATH } from './config.ts';

export interface RequestLogEntry {
  at: string;
  provider: string;
  url: string;
  outcome: 'success' | 'failure';
  durationMs: number;
  attempts?: number;
  status?: number;
  idCount?: number;
  /** 成功响应里是否真的走到了注册；会话在响应到达之前结束时为 false。失败响应不带这一项。 */
  registered?: boolean;
  /** 走 maxTokens 或 input 默认值的模型 id 数组，只在成功响应里出现。 */
  pendingExtras?: string[];
  error?: string;
}

export function appendLog(entry: RequestLogEntry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
}
