// parseModelIds()、toModelIds()、selectModels()、fetchWithRetry() 与默认来源的单元测试。
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpencodeGoSource,
  fetchWithRetry,
  parseModelIds,
  selectModels,
  SourceError,
  toModelIds,
} from './index.ts';

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

describe('toModelIds', () => {
  it('结构正常时返回去重后的 id', () => {
    expect(toModelIds({ data: [{ id: 'a' }, { id: 'a' }] }, 1, 200)).toEqual(['a']);
  });

  it('结构不对时抛出带尝试次数与状态码的 SourceError', () => {
    let thrown: unknown;
    try {
      toModelIds({ models: [] }, 2, 200);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceError);
    expect(thrown).toMatchObject({ attempts: 2, status: 200 });
  });
});

describe('selectModels', () => {
  const piModels = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('只保留来源给出且 pi 认识的模型', () => {
    expect(selectModels(['a', 'c'], piModels, []).map((model) => model.id)).toEqual(['a', 'c']);
  });

  it('来源给出但 pi 不认识的模型丢弃', () => {
    expect(selectModels(['a', 'zzz'], piModels, []).map((model) => model.id)).toEqual(['a']);
  });

  it('命中排除清单的模型不出现', () => {
    expect(selectModels(['a', 'b', 'c'], piModels, ['b']).map((model) => model.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('排除清单按完整 id 匹配，前缀相同的其他 id 不受影响', () => {
    const models = [{ id: 'glm-5.1' }, { id: 'glm-5.1-flash' }];
    expect(
      selectModels(['glm-5.1', 'glm-5.1-flash'], models, ['glm-5.1']).map((model) => model.id),
    ).toEqual(['glm-5.1-flash']);
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

describe('fetchWithRetry', () => {
  const signal = new AbortController().signal;

  it('遇到可重试的状态码会再试，成功后返回该响应', async () => {
    let calls = 0;
    const { response, attempts } = await fetchWithRetry(async () => {
      calls += 1;
      return new Response(null, { status: calls < 3 ? 503 : 200 });
    }, signal);
    expect(attempts).toBe(3);
    expect(response.status).toBe(200);
  });

  it('尝试次数用完之后返回最后一次响应', async () => {
    const { response, attempts } = await fetchWithRetry(
      async () => new Response(null, { status: 500 }),
      signal,
    );
    expect(attempts).toBe(3);
    expect(response.status).toBe(500);
  });

  it('不可重试的状态码只请求一次', async () => {
    let calls = 0;
    const { attempts } = await fetchWithRetry(async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }, signal);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('传输错误也会重试', async () => {
    let calls = 0;
    const { response, attempts } = await fetchWithRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('socket hang up');
      return new Response(null, { status: 200 });
    }, signal);
    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
  });

  it('传输错误一直失败时抛出 SourceError 并带上尝试次数', async () => {
    await expect(
      fetchWithRetry(async () => {
        throw new Error('boom');
      }, signal),
    ).rejects.toThrow(SourceError);
    await expect(
      fetchWithRetry(async () => {
        throw new Error('boom');
      }, signal),
    ).rejects.toMatchObject({ attempts: 3, message: 'boom' });
  });

  it('调用方已经取消时直接抛 SourceError，不再发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    let thrown: unknown;
    try {
      await fetchWithRetry(async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      }, controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceError);
    expect(thrown).toMatchObject({ attempts: 1 });
    expect(calls).toBe(0);
  });

  it('自定义尝试上限时按上限停止', async () => {
    const { attempts } = await fetchWithRetry(
      async () => new Response(null, { status: 500 }),
      signal,
      2,
    );
    expect(attempts).toBe(2);
  });

  it('重试之前丢弃上一次的响应体', async () => {
    let calls = 0;
    let firstResponse: Response | undefined;
    await fetchWithRetry(async () => {
      calls += 1;
      const response =
        calls === 1 ? new Response('busy', { status: 503 }) : new Response(null, { status: 200 });
      if (calls === 1) firstResponse = response;
      return response;
    }, signal);
    expect(firstResponse?.bodyUsed).toBe(true);
  });
});

describe('createOpencodeGoSource', () => {
  function fakeContext(): ExtensionContext {
    return {
      modelRegistry: {
        getProvider: () => ({
          baseUrl: 'https://example.com/v1',
          getModels: () => [
            { id: 'a', api: 'openai-completions', baseUrl: 'https://example.com/v1' },
          ],
        }),
        getApiKeyForProvider: async () => 'test-key',
      },
    } as unknown as ExtensionContext;
  }

  it('响应体读取阶段被中止时抛 SourceError', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => {
      controller.abort();
      return new Response('not json', { status: 200 });
    });
    try {
      const source = createOpencodeGoSource(fakeContext());
      await expect(source.fetchIds(controller.signal)).rejects.toThrow(SourceError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
