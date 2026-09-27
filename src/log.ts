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
  error?: string;
}

export function appendLog(entry: RequestLogEntry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
}
