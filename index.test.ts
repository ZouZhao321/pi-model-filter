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
import {
  createNpmPackageDocSource,
  parseCommaList,
  parseMetadataDocument,
  parsePriceSlashCache,
  parseSizeSuffix,
} from './src/metadata.ts';
import { parseProvidersConfig } from './src/providers.ts';
import { fetchWithRetry, SourceError } from './src/retry.ts';
import type {
  CatalogDeclaration,
  CatalogEntry,
  CatalogSourceFactory,
  MetadataCache,
  MetadataEntry,
  MetadataSourceFactory,
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

const METADATA_OBJECT = {
  kind: 'npm-package-doc',
  package: 'command-code',
  file: 'dist/bundled/command-code-knowledge/reference/models.md',
  versionUrl: 'https://registry.npmjs.org/{package}/latest',
  fileUrl: 'https://unpkg.com/{package}@{version}/{file}',
  format: 'markdown-table',
  columns: { id: 0, name: 1, contextWindow: 2, thinkingLevel: 3, cost: 4 },
  valueParsers: {
    contextWindow: 'size-suffix',
    thinkingLevel: 'comma-list',
    cost: 'price-slash-cache',
  },
};

function commandcodeWithMetadata(): ProviderDeclaration {
  const config = configObject();
  (config.commandcode as Record<string, unknown>).metadata = METADATA_OBJECT;
  const declaration = parseProvidersConfig(config).get('commandcode');
  if (!declaration) throw new Error('测试配置里没有 commandcode');
  return declaration;
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

  it('metadata.kind 不认识时抛出', () => {
    const config = configObject();
    (config.commandcode as Record<string, unknown>).metadata = {
      ...METADATA_OBJECT,
      kind: 'npm-package-json',
    };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode 的 metadata.kind 不认识 npm-package-json（已知：npm-package-doc）',
    );
  });

  it('metadata.format 不认识时抛出', () => {
    const config = configObject();
    (config.commandcode as Record<string, unknown>).metadata = {
      ...METADATA_OBJECT,
      format: 'csv-table',
    };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode 的 metadata.format 不认识 csv-table（已知：markdown-table）',
    );
  });

  it('metadata.valueParsers 的解析器不认识时抛出', () => {
    const config = configObject();
    (config.commandcode as Record<string, unknown>).metadata = {
      ...METADATA_OBJECT,
      valueParsers: { ...METADATA_OBJECT.valueParsers, cost: 'usd-per-mega' },
    };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode 的 metadata 的 valueParsers.cost 不认识 usd-per-mega（已知：size-suffix、comma-list、price-slash-cache）',
    );
  });

  it('metadata.columns 缺必填项时抛出', () => {
    const config = configObject();
    (config.commandcode as Record<string, unknown>).metadata = {
      ...METADATA_OBJECT,
      columns: { id: 0, name: 1, contextWindow: 2, thinkingLevel: 3 },
    };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode 的 metadata 的 columns 缺少必填项 cost',
    );
  });

  it('metadata.columns 有不认识的项时抛出', () => {
    const config = configObject();
    (config.commandcode as Record<string, unknown>).metadata = {
      ...METADATA_OBJECT,
      columns: { ...METADATA_OBJECT.columns, price: 4 },
    };
    expect(() => parseProvidersConfig(config)).toThrow(
      'providers.json 里 provider commandcode 的 metadata 的 columns 有不认识的项 price',
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

describe('三个值解析器', () => {
  it('size-suffix 解析 M、K、小数与纯数字，无值返回 undefined', () => {
    expect(parseSizeSuffix('1M')).toBe(1000000);
    expect(parseSizeSuffix('262K')).toBe(262000);
    expect(parseSizeSuffix('1.05M')).toBe(1050000);
    expect(parseSizeSuffix('1000000')).toBe(1000000);
    expect(parseSizeSuffix('—')).toBeUndefined();
    expect(parseSizeSuffix('')).toBeUndefined();
  });

  it('size-suffix 遇到不认识的后缀抛出并带原字符串', () => {
    expect(() => parseSizeSuffix('1G')).toThrow('无法解析 size-suffix 值：1G');
  });

  it('comma-list 拆分逗号列表，无值返回空数组', () => {
    expect(parseCommaList('high, max')).toEqual(['high', 'max']);
    expect(parseCommaList('low, medium, xhigh')).toEqual(['low', 'medium', 'xhigh']);
    expect(parseCommaList('—')).toEqual([]);
    expect(parseCommaList('')).toEqual([]);
  });

  it('price-slash-cache 解析带 write 与不带 write 的价格，$0/$0 也能解析', () => {
    expect(parsePriceSlashCache('$0.15/$0.6 · cache $0.003')).toEqual({
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
    });
    expect(parsePriceSlashCache('$2/$6 · cache $0.25 (write $2.5)')).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.25,
      cacheWrite: 2.5,
    });
    expect(parsePriceSlashCache('$0/$0 · cache $0')).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
    });
    expect(parsePriceSlashCache('—')).toBeUndefined();
  });

  it('price-slash-cache 遇到不符合预期的写法抛出并带原字符串', () => {
    expect(() => parsePriceSlashCache('$0.15/$0.6')).toThrow(
      '无法解析 price-slash-cache 值：$0.15/$0.6',
    );
  });
});

describe('parseMetadataDocument', () => {
  const MARKDOWN = [
    '# Models',
    '',
    '## Open Source',
    '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |',
    '|---|---|---|---|---|---|---|',
    '| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (latest) | 1M | high, max | $0.66/$1.98 · cache $0.022 | Go and above | x |',
    '| `zai-org/GLM-5.1` | GLM-5.1 | — | — | $1.4/$4.4 · cache $0.26 | Go and above | x |',
    '',
    '## Anthropic',
    '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |',
    '|---|---|---|---|---|---|---|',
    '| `claude-sonnet-5` | Claude Sonnet 5 | 1M | low, medium, high, xhigh, max | $2/$10 · cache $0.2 (write $2.5) | Pro and above | x |',
    '',
  ].join('\n');

  it('跳过表头行与分隔行，把多张表解析成 Map', () => {
    const declaration = commandcodeWithMetadata();
    const result = parseMetadataDocument(MARKDOWN, declaration.metadata!);
    expect(result.size).toBe(3);
    expect(result.get('deepseek/deepseek-v4-pro')).toEqual({
      name: 'DeepSeek V4 Pro (latest)',
      contextWindow: 1000000,
      thinkingLevel: ['high', 'max'],
      cost: { input: 0.66, output: 1.98, cacheRead: 0.022 },
    });
    expect(result.get('zai-org/GLM-5.1')).toEqual({
      name: 'GLM-5.1',
      contextWindow: undefined,
      thinkingLevel: [],
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    });
    expect(result.get('claude-sonnet-5')?.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
  });

  it('换一组列映射，解析结果跟着变', () => {
    const declaration = commandcodeWithMetadata();
    const md = [
      '| id | a | b | c | d |',
      '|---|---|---|---|---|',
      '| `x` | 1M | 2M | high | $1/$2 · cache $0.5 |',
    ].join('\n');
    const swapped: ProviderDeclaration = {
      ...declaration,
      metadata: {
        ...declaration.metadata!,
        columns: { id: 0, name: 2, contextWindow: 1, thinkingLevel: 3, cost: 4 },
      },
    };
    expect(parseMetadataDocument(md, swapped.metadata!).get('x')).toMatchObject({
      name: '2M',
      contextWindow: 1000000,
      thinkingLevel: ['high'],
      cost: { input: 1, output: 2, cacheRead: 0.5 },
    });
    expect(parseMetadataDocument(md, declaration.metadata!).get('x')).toMatchObject({
      name: '1M',
      contextWindow: 2000000,
    });
  });
});

describe('createNpmPackageDocSource', () => {
  const MARKDOWN = [
    '| Id | Name | Context | Efforts | $/1M in/out | Min plan | Best for |',
    '|---|---|---|---|---|---|---|',
    '| `a` | A | 1M | high | $1/$2 · cache $0.5 | Go | x |',
    '',
  ].join('\n');

  it('版本号与缓存一致时只取版本，不下载文档', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return url.includes('registry.npmjs.org')
        ? Response.json({ version: '1.66.0' }, { status: 200 })
        : new Response(MARKDOWN, { status: 200 });
    });
    try {
      const source = createNpmPackageDocSource(commandcodeWithMetadata());
      const result = await source.fetchMetadata(new AbortController().signal, '1.66.0');
      expect(result).toEqual({ version: '1.66.0', entries: undefined, attempts: 1 });
      expect(calls).toEqual(['https://registry.npmjs.org/command-code/latest']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('版本号不同时下载文档并解析', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return url.includes('registry.npmjs.org')
        ? Response.json({ version: '1.66.0' }, { status: 200 })
        : new Response(MARKDOWN, { status: 200 });
    });
    try {
      const source = createNpmPackageDocSource(commandcodeWithMetadata());
      const result = await source.fetchMetadata(new AbortController().signal, '1.65.0');
      expect(result.version).toBe('1.66.0');
      expect(result.entries?.get('a')).toMatchObject({
        name: 'A',
        contextWindow: 1000000,
        thinkingLevel: ['high'],
        cost: { input: 1, output: 2, cacheRead: 0.5 },
      });
      expect(calls).toEqual([
        'https://registry.npmjs.org/command-code/latest',
        'https://unpkg.com/command-code@1.66.0/dist/bundled/command-code-knowledge/reference/models.md',
      ]);
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
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1050000,
      maxTokens: 16384,
      compat: { supportsDeveloperRole: false },
    });
  });

  it('metadata 给 cost、thinkingLevelMap 与 reasoning，contextWindow 仍以端点为准', () => {
    const metadata = new Map<string, MetadataEntry>([
      [
        'deepseek/deepseek-v4-pro',
        {
          name: 'DeepSeek V4 Pro',
          contextWindow: 999999,
          thinkingLevel: ['high', 'max'],
          cost: { input: 0.66, output: 1.98, cacheRead: 0.022 },
        },
      ],
    ]);
    const model = composeModels(commandcode(), entries, [], metadata).find(
      (item) => item.id === 'deepseek/deepseek-v4-pro',
    );
    expect(model).toMatchObject({
      reasoning: true,
      contextWindow: 1000000,
      cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
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

describe('refreshCatalog 的元数据处理', () => {
  const entry: CatalogEntry = {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    endpoints: ['/chat/completions'],
  };
  const providers: ProviderRef[] = [
    { providerId: 'commandcode', declaration: commandcodeWithMetadata() },
  ];
  const cachedMetadata: MetadataCache = {
    version: '1.66.0',
    entries: new Map<string, MetadataEntry>([
      [
        'deepseek/deepseek-v4-pro',
        {
          name: 'DeepSeek V4 Pro',
          contextWindow: 900000,
          thinkingLevel: ['high', 'max'],
          cost: { input: 0.66, output: 1.98, cacheRead: 0.022 },
        },
      ],
    ]),
  };

  function fakePi() {
    const registered: { providerId: string; models?: unknown[] }[] = [];
    const pi = {
      registerProvider: (providerId: string, config: { models?: unknown[] }) => {
        registered.push({ providerId, models: config.models });
      },
    };
    return { pi: pi as unknown as ExtensionAPI, registered };
  }

  it('元数据下载失败时沿用上一次缓存并写失败日志，目录照常保存', async () => {
    const { pi, registered } = fakePi();
    const effects = {
      saveAvailableIds: vi.fn(),
      saveCatalogCache: vi.fn(),
      saveMetadataCache: vi.fn(),
      loadMetadataCache: vi.fn(() => cachedMetadata),
      appendLog: vi.fn(),
    };
    const failingMetadata: MetadataSourceFactory = () => ({
      url: 'https://registry.npmjs.org/command-code/latest',
      fetchMetadata: async () => {
        throw new SourceError('接口返回 HTTP 503', 3, 503);
      },
    });
    const catalogSource: CatalogSourceFactory = () => ({
      url: 'https://api.commandcode.ai/provider/v1/models',
      fetchEntries: async () => ({ entries: [entry], attempts: 1 }),
    });

    await refreshCatalog(
      pi,
      {} as ExtensionContext,
      providers,
      providers[0].declaration,
      [],
      { ended: false },
      catalogSource,
      effects,
      failingMetadata,
    );

    expect(registered).toEqual([
      {
        providerId: 'commandcode',
        models: [
          expect.objectContaining({
            id: 'deepseek/deepseek-v4-pro',
            reasoning: true,
            contextWindow: 1000000,
            cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
            thinkingLevelMap: {
              minimal: null,
              low: null,
              medium: null,
              high: 'high',
              xhigh: null,
              max: 'max',
            },
          }),
        ],
      },
    ]);
    expect(effects.saveCatalogCache).toHaveBeenCalledWith('commandcode', [entry]);
    expect(effects.saveMetadataCache).not.toHaveBeenCalled();
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', attempts: 3, status: 503 }),
    );
    expect(effects.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', idCount: 1 }),
    );
  });
});
