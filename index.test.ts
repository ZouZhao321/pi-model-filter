// matches() 的通配符语义单元测试：精确匹配与 * 通配符。
import { describe, expect, it } from 'vitest';
import { matches } from './index.ts';

describe('matches', () => {
  it('不含通配符时要求完全相等', () => {
    expect(matches('grok-4.5', 'grok-4.5')).toBe(true);
    expect(matches('grok-4.5', 'grok-4.5-fast')).toBe(false);
  });

  it('单个 * 匹配任意片段', () => {
    expect(matches('muse-spark-*', 'muse-spark-2')).toBe(true);
    expect(matches('muse-spark-*', 'muse-spark-2-preview')).toBe(true);
    expect(matches('muse-spark-*', 'muse-pro-2')).toBe(false);
  });

  it('通配符出现在开头与中间时同样生效', () => {
    expect(matches('*preview', 'glm-5-preview')).toBe(true);
    expect(matches('glm-*-flash', 'glm-5.3-flash')).toBe(true);
    expect(matches('glm-*-flash', 'glm-5.3-pro')).toBe(false);
  });

  it('模式中的正则元字符按字面处理', () => {
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
  });
});
