// matches() 的通配符语义、parseModelIds() 与 selectModels() 的单元测试。
import { describe, expect, it } from 'vitest';
import { matches, parseModelIds, selectModels } from './index.ts';

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

describe('parseModelIds', () => {
  it('取 data 数组里的 id', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });

  it('条目缺 id 或者不是对象时跳过', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, {}, null, 'x', { id: 3 }] })).toEqual(['a']);
  });

  it('同一个 id 只留一次', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'a' }] })).toEqual(['a']);
  });

  it('结构里没有 data 数组时抛出', () => {
    expect(() => parseModelIds({ models: [] })).toThrow();
    expect(() => parseModelIds(null)).toThrow();
  });
});

describe('selectModels', () => {
  const piModels = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('只保留接口给出且 pi 认识的模型', () => {
    expect(selectModels(['a', 'c'], piModels, []).map((model) => model.id)).toEqual(['a', 'c']);
  });

  it('接口给出但 pi 不认识的模型丢弃', () => {
    expect(selectModels(['a', 'zzz'], piModels, []).map((model) => model.id)).toEqual(['a']);
  });

  it('命中排除清单的模型不出现', () => {
    expect(selectModels(['a', 'b', 'c'], piModels, ['b']).map((model) => model.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('排除清单里的通配符生效', () => {
    const models = [{ id: 'muse-spark-1' }, { id: 'muse-spark-2' }, { id: 'other' }];
    expect(
      selectModels(['muse-spark-1', 'muse-spark-2', 'other'], models, ['muse-spark-*']).map(
        (model) => model.id,
      ),
    ).toEqual(['other']);
  });

  it('名单为空时结果为空', () => {
    expect(selectModels([], piModels, [])).toEqual([]);
  });

  it('排除清单覆盖全部模型时结果为空', () => {
    expect(selectModels(['a', 'b', 'c'], piModels, ['a', 'b', 'c'])).toEqual([]);
  });

  it('保留 pi 列表里的顺序', () => {
    expect(selectModels(['c', 'a'], piModels, []).map((model) => model.id)).toEqual(['a', 'c']);
  });
});
