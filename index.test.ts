// parseModelIds()、toModelIds()、parseCatalogEntries()、toCatalogEntries()、selectModels()、
// composeModels()、parseProvidersConfig()、createOpencodeGoSource()、createHttpModelListSource()、
// refresh()、refreshCatalog() 与 fetchWithRetry() 的单元测试。
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { refresh, refreshCatalog, type ProviderRef } from './index.ts';
import {
  createHttpModelListSource,
  createOpencodeGoSource,
  parseCatalogEntries,
  parseModelIds,
  toCatalogEntries,
  toModelIds,
} from './src/catalog.ts';
import { composeModels, selectModels } from './src/compose.ts';
import { parseProvidersConfig } from './src/providers.ts';
import { fetchWithRetry, SourceError } from './src/retry.ts';
import type {
  CatalogDeclaration,
  CatalogEntry,
  CatalogSourceFactory,
  ProviderDeclaration,
  SourceFactory,
} from './src/types.ts';

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

// 一份与 providers.json 同形的配置对象：commandcode 声明目录来源，commandcode-2 引用它。
const CATALOG_OBJECT = {
  kind: 'http-model-list',
  url: '{baseUrl}/models',
  requestHeaders: { accept: 'application/json' },
  authHeader: 'bearer',
  envelope: 'openai-data-array',
  fields: {
    id: 'id',
    name: 'name',
    contextWindow: 'context_length',
    endpoints: 'supported_endpoints',
  },
};

function configObject(
  declarationOverrides: Record<string, unknown> = {},
  catalogOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    commandcode: {
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      api: 'openai-completions',
      compat: { supportsDeveloperRole: false },
      catalog: { ...CATALOG_OBJECT, ...catalogOverrides },
      extras: 'model-extras.json',
      exclusions: 'model-exclude.json',
      ...declarationOverrides,
    },
    'commandcode-2': { source: 'commandcode' },
  };
}

function commandcode(): ProviderDeclaration {
  const declaration = parseProvidersConfig(configObject()).get('commandcode');
  if (!declaration) throw new Error('测试配置里没有 commandcode');
  return declaration;
}

function catalogWith(fields: Record<string, string>): CatalogDeclaration {
  return { ...commandcode().catalog, fields: { ...commandcode().catalog.fields, ...fields } };
}

describe('parseProvidersConfig', () => {
  it('引用声明没写 name 时，引用方与被引用方共用同一份声明', () => {
    const providers = parseProvidersConfig(configObject());
    expect([...providers.keys()]).toEqual(['commandcode', 'commandcode-2']);
    expect(providers.get('commandcode-2')).toBe(providers.get('commandcode'));
    expect(providers.get('commandcode')).toMatchObject({
      sourceProviderId: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      api: 'openai-completions',
      extras: 'model-extras.json',
      exclusions: 'model-exclude.json',
      catalog: {
        kind: 'http-model-list',
        url: '{baseUrl}/models',
        requestHeaders: { accept: 'application/json' },
        authHeader: 'bearer',
        envelope: 'openai-data-array',
      },
    });
  });

  it('requestHeaders 与 compat 可以省略', () => {
    const providers = parseProvidersConfig(
      configObject({ compat: undefined }, { requestHeaders: undefined, authHeader: undefined }),
    );
    expect(providers.get('commandcode')).toMatchObject({
      compat: undefined,
      catalog: { requestHeaders: {}, authHeader: undefined },
    });
  });

  it('缺必填项时抛出，错误信息带上 provider 名与缺的项', () => {
    expect(() => parseProvidersConfig(configObject({ baseUrl: undefined }))).toThrow(
      'providers.json 里 provider commandcode 缺少必填项 baseUrl',
    );
    expect(() => parseProvidersConfig(configObject({ name: undefined }))).toThrow(
      'providers.json 里 provider commandcode 缺少必填项 name',
    );
    expect(() => parseProvidersConfig(configObject({ api: '' }))).toThrow(
      'providers.json 里 provider commandcode 缺少必填项 api',
    );
    expect(() => parseProvidersConfig(configObject({}, { url: undefined }))).toThrow(
      'providers.json 里 provider commandcode 的 catalog 缺少必填项 url',
    );
    expect(() =>
      parseProvidersConfig(
        configObject({}, { fields: { id: 'id', name: 'name', contextWindow: 'context_length' } }),
      ),
    ).toThrow('providers.json 里 provider commandcode 的 catalog 的 fields 缺少必填项 endpoints');
  });

  it('缺 catalog 时抛出', () => {
    expect(() => parseProvidersConfig(configObject({ catalog: undefined }))).toThrow(
      'providers.json 里 provider commandcode 的 catalog 必须是一个对象',
    );
  });

  it('kind 不认识时抛出', () => {
    expect(() => parseProvidersConfig(configObject({}, { kind: 'graphql-model-list' }))).toThrow(
      'providers.json 里 provider commandcode 的 catalog.kind 不认识 graphql-model-list（已知：http-model-list）',
    );
  });

  it('envelope 不认识时抛出', () => {
    expect(() => parseProvidersConfig(configObject({}, { envelope: 'openai-array' }))).toThrow(
      'providers.json 里 provider commandcode 的 catalog.envelope 不认识 openai-array（已知：openai-data-array）',
    );
  });

  it('authHeader 不认识时抛出', () => {
    expect(() => parseProvidersConfig(configObject({}, { authHeader: 'basic' }))).toThrow(
      'providers.json 里 provider commandcode 的 catalog.authHeader 不认识 basic（已知：bearer）',
    );
  });

  it('fields 有不认识的项时抛出', () => {
    expect(() =>
      parseProvidersConfig(
        configObject({}, { fields: { ...CATALOG_OBJECT.fields, price: 'cost' } }),
      ),
    ).toThrow('providers.json 里 provider commandcode 的 catalog 的 fields 有不认识的项 price');
  });

  it('引用了不存在的来源名时抛出', () => {
    const config = configObject();
    config['commandcode-2'] = { source: 'commandcode-3' };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode-2 引用的来源 commandcode-3 不存在',
    );
  });

  it('引用声明带 name 时通过，名字覆盖被引用方', () => {
    const config = configObject();
    config['commandcode-2'] = { source: 'commandcode', name: 'Command Code (GOAT) #2' };
    const providers = parseProvidersConfig(config);
    const declaration = providers.get('commandcode-2');
    expect(declaration?.name).toBe('Command Code (GOAT) #2');
    expect(providers.get('commandcode')?.name).toBe('Command Code');
    expect(declaration).not.toBe(providers.get('commandcode'));
    expect(declaration).toMatchObject({
      sourceProviderId: 'commandcode',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      api: 'openai-completions',
      extras: 'model-extras.json',
      exclusions: 'model-exclude.json',
    });
    expect(declaration?.catalog).toEqual(providers.get('commandcode')?.catalog);
  });

  it('引用声明再声明其他项时抛出', () => {
    for (const key of ['baseUrl', 'api', 'compat', 'catalog', 'extras', 'exclusions']) {
      const config = configObject();
      config['commandcode-2'] = { source: 'commandcode', [key]: 'x' };
      expect(() => parseProvidersConfig(config)).toThrow(
        `providers.json 里 provider commandcode-2 声明了 source，不能再声明 ${key}`,
      );
    }
  });

  it('来源引用形成循环时抛出', () => {
    expect(() => parseProvidersConfig({ a: { source: 'b' }, b: { source: 'a' } })).toThrow(
      'providers.json 里 provider a 的来源引用形成了循环',
    );
  });

  it('声明的文件名不能带路径分隔符', () => {
    expect(() => parseProvidersConfig(configObject({ exclusions: '../other.json' }))).toThrow(
      'providers.json 里 provider commandcode 的 exclusions 只能是插件数据目录下的文件名：../other.json',
    );
  });

  it('顶层或者 provider 的值不是对象时抛出', () => {
    expect(() => parseProvidersConfig([])).toThrow('providers.json 的顶层 必须是一个对象');
    expect(() => parseProvidersConfig({ commandcode: 'x' })).toThrow(
      'providers.json 里 provider commandcode 必须是一个对象',
    );
  });
});

describe('parseCatalogEntries', () => {
  const entry = {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    context_length: 1050000,
    supported_endpoints: ['/chat/completions', '/responses'],
  };

  it('按来源声明给的字段映射取出条目', () => {
    const catalog = catalogWith({});
    expect(parseCatalogEntries({ data: [entry] }, catalog)).toEqual([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 1050000,
        endpoints: ['/chat/completions', '/responses'],
      },
    ]);
  });

  it('换一组字段映射，解析结果跟着变', () => {
    const other = catalogWith({
      id: 'model_id',
      name: 'display_name',
      contextWindow: 'max_context_tokens',
      endpoints: 'endpoint_groups',
    });
    const payload = {
      data: [
        {
          model_id: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          max_context_tokens: 1050000,
          endpoint_groups: ['/chat/completions'],
          id: 'ignored',
          context_length: 1,
        },
      ],
    };
    expect(parseCatalogEntries(payload, other)).toEqual([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 1050000,
        endpoints: ['/chat/completions'],
      },
    ]);
    // 同一份响应按原来的映射解析，读的是原来的字段名
    expect(parseCatalogEntries(payload, catalogWith({}))).toEqual([]);
  });

  it('条目缺 id、或者必要字段不是预期类型时跳过', () => {
    const catalog = catalogWith({});
    expect(
      parseCatalogEntries(
        {
          data: [
            entry,
            {},
            null,
            'x',
            { ...entry, id: '' },
            { ...entry, id: 3 },
            { ...entry, name: 3 },
            { ...entry, context_length: '1050000' },
            { ...entry, supported_endpoints: '/chat/completions' },
          ],
        },
        catalog,
      ),
    ).toEqual([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 1050000,
        endpoints: ['/chat/completions', '/responses'],
      },
    ]);
  });

  it('同一个 id 只留一次', () => {
    const catalog = catalogWith({});
    expect(parseCatalogEntries({ data: [entry, entry] }, catalog)).toHaveLength(1);
  });

  it('顶层没有 data 数组时抛出', () => {
    const catalog = catalogWith({});
    expect(() => parseCatalogEntries({ models: [] }, catalog)).toThrow();
    expect(() => parseCatalogEntries(null, catalog)).toThrow();
  });

  it('toCatalogEntries 把结构错误包成带尝试次数与状态码的 SourceError', () => {
    let thrown: unknown;
    try {
      toCatalogEntries({ models: [] }, catalogWith({}), 2, 200);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceError);
    expect(thrown).toMatchObject({ attempts: 2, status: 200 });
  });
});

describe('createHttpModelListSource', () => {
  function fakeContext(key: string | undefined): ExtensionContext {
    return {
      modelRegistry: { getApiKeyForProvider: async () => key },
    } as unknown as ExtensionContext;
  }

  const body = {
    data: [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        context_length: 1050000,
        supported_endpoints: ['/chat/completions', '/responses'],
      },
    ],
  };

  it('用 baseUrl 展开请求地址，按声明的请求头发请求并带上凭据', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return Response.json(body, { status: 200 });
    });
    try {
      const source = createHttpModelListSource(fakeContext('secret'), 'commandcode', commandcode());
      expect(source.url).toBe('https://api.commandcode.ai/provider/v1/models');
      const { entries, attempts } = await source.fetchEntries(new AbortController().signal);
      expect(entries).toEqual([
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          contextWindow: 1050000,
          endpoints: ['/chat/completions', '/responses'],
        },
      ]);
      expect(attempts).toBe(1);
      expect(calls[0]).toEqual({
        url: 'https://api.commandcode.ai/provider/v1/models',
        headers: { accept: 'application/json', authorization: 'Bearer secret' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('取不到凭据时抛 SourceError，不发请求', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return Response.json(body, { status: 200 });
    });
    try {
      const source = createHttpModelListSource(
        fakeContext(undefined),
        'commandcode',
        commandcode(),
      );
      await expect(source.fetchEntries(new AbortController().signal)).rejects.toThrow(SourceError);
      expect(calls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('composeModels', () => {
  const entries: CatalogEntry[] = [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 1050000,
      endpoints: ['/chat/completions', '/responses'],
    },
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      contextWindow: 200000,
      endpoints: ['/messages'],
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1000000,
      endpoints: ['/chat/completions'],
    },
  ];

  it('接口分组里没有 /chat/completions 的条目丢弃，并保持目录里的先后次序', () => {
    expect(composeModels(commandcode(), entries, []).map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'deepseek/deepseek-v4-pro',
    ]);
  });

  it('命中排除表的 id 不出现，前缀相同的其他 id 不受影响', () => {
    expect(
      composeModels(commandcode(), entries, ['deepseek/deepseek-v4-pro']).map((model) => model.id),
    ).toEqual(['gpt-5.6-sol']);
    const prefixed: CatalogEntry[] = [
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, endpoints: ['/chat/completions'] },
      {
        id: 'glm-5.1-flash',
        name: 'GLM-5.1 Flash',
        contextWindow: 200000,
        endpoints: ['/chat/completions'],
      },
    ];
    expect(composeModels(commandcode(), prefixed, ['glm-5.1']).map((model) => model.id)).toEqual([
      'glm-5.1-flash',
    ]);
  });

  it('排除表覆盖全部条目时结果为空', () => {
    expect(
      composeModels(
        commandcode(),
        entries,
        entries.map((entry) => entry.id),
      ),
    ).toEqual([]);
  });

  it('目录为空时返回空数组，不抛出', () => {
    expect(composeModels(commandcode(), [], [])).toEqual([]);
  });

  it('字段按来源取值：目录给 id、name、contextWindow，provider 定义给 api、baseUrl、compat', () => {
    expect(composeModels(commandcode(), entries, [])[0]).toEqual({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      api: 'openai-completions',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1050000,
      maxTokens: 16384,
      compat: { supportsDeveloperRole: false },
    });
  });
});

// 会话结束时 pi 与 ctx 都已经失效，晚到的成功响应只能写缓存与日志，不能再调注册接口。
describe('refresh 与 refreshCatalog 的会话结束处理', () => {
  const entries: CatalogEntry[] = [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 1050000,
      endpoints: ['/chat/completions'],
    },
  ];
  const providers: ProviderRef[] = [{ providerId: 'commandcode', declaration: commandcode() }];

  function fakePi() {
    const registered: { providerId: string; name: string; modelCount: number }[] = [];
    const pi = {
      registerProvider: (providerId: string, config: { name: string; models?: unknown[] }) => {
        registered.push({ providerId, name: config.name, modelCount: config.models?.length ?? 0 });
      },
    };
    return { pi: pi as unknown as ExtensionAPI, registered };
  }

  function fakeEffects() {
    return { saveAvailableIds: vi.fn(), saveCatalogCache: vi.fn(), appendLog: vi.fn() };
  }

  function catalogSource(list: CatalogEntry[]): CatalogSourceFactory {
    return () => ({
      url: 'https://api.commandcode.ai/provider/v1/models',
      fetchEntries: async () => ({ entries: list, attempts: 1 }),
    });
  }

  function opencodeGoPi(): {
    pi: ExtensionAPI;
    registered: { providerId: string; name: string; modelCount: number }[];
    getProvider: ReturnType<typeof vi.fn>;
    ctx: ExtensionContext;
  } {
    const { pi, registered } = fakePi();
    const getProvider = vi.fn(() => ({
      name: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      getModels: () => [
        { id: 'glm-5.2', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1' },
      ],
    }));
    return {
      pi,
      registered,
      getProvider,
      ctx: { modelRegistry: { getProvider } } as unknown as ExtensionContext,
    };
  }

  const listSource: SourceFactory = () => ({
    url: 'https://opencode.ai/zen/go/v1/models',
    fetchIds: async () => ({ ids: ['glm-5.2'], attempts: 1 }),
  });

  it('会话未结束时注册并写日志，日志标注 registered: true', async () => {
    const { pi, registered } = fakePi();
    const effects = fakeEffects();
    await refreshCatalog(
      pi,
      {} as ExtensionContext,
      providers,
      providers[0].declaration,
      [],
      { ended: false },
      catalogSource(entries),
      effects,
    );
    expect(registered).toEqual([
      { providerId: 'commandcode', name: 'Command Code', modelCount: 1 },
    ]);
    expect(effects.saveCatalogCache).toHaveBeenCalledWith('commandcode', entries);
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'commandcode',
        outcome: 'success',
        attempts: 1,
        idCount: 1,
        registered: true,
      }),
    );
  });

  it('会话结束时只写缓存与日志，不注册，日志标注 registered: false', async () => {
    const { pi, registered } = fakePi();
    const effects = fakeEffects();
    await refreshCatalog(
      pi,
      {} as ExtensionContext,
      providers,
      providers[0].declaration,
      [],
      { ended: true },
      catalogSource(entries),
      effects,
    );
    expect(registered).toEqual([]);
    expect(effects.saveCatalogCache).toHaveBeenCalledWith('commandcode', entries);
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', idCount: 1, registered: false }),
    );
  });

  it('旧路径会话未结束时注册并写名单文件', async () => {
    const { pi, registered, getProvider, ctx } = opencodeGoPi();
    const effects = fakeEffects();
    await refresh(pi, ctx, [], { ended: false }, listSource, effects);
    expect(getProvider).toHaveBeenCalled();
    expect(registered).toEqual([{ providerId: 'opencode-go', name: 'opencode-go', modelCount: 1 }]);
    expect(effects.saveAvailableIds).toHaveBeenCalledWith(['glm-5.2']);
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'opencode-go', outcome: 'success', registered: true }),
    );
  });

  it('旧路径会话结束时只写名单文件，不碰 ctx 与注册', async () => {
    const { pi, registered, getProvider, ctx } = opencodeGoPi();
    const effects = fakeEffects();
    await refresh(pi, ctx, [], { ended: true }, listSource, effects);
    expect(getProvider).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
    expect(effects.saveAvailableIds).toHaveBeenCalledWith(['glm-5.2']);
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', registered: false }),
    );
  });

  it('失败的响应记 failure，不带 registered 字段', async () => {
    const { pi, registered } = fakePi();
    const effects = fakeEffects();
    const failing: CatalogSourceFactory = () => ({
      url: 'https://api.commandcode.ai/provider/v1/models',
      fetchEntries: async () => {
        throw new SourceError('接口返回 HTTP 500', 1, 500);
      },
    });
    await refreshCatalog(
      pi,
      {} as ExtensionContext,
      providers,
      providers[0].declaration,
      [],
      { ended: false },
      failing,
      effects,
    );
    expect(registered).toEqual([]);
    expect(effects.saveCatalogCache).not.toHaveBeenCalled();
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', attempts: 1, status: 500 }),
    );
    expect(effects.appendLog.mock.calls[0][0]).not.toHaveProperty('registered');
  });
});
