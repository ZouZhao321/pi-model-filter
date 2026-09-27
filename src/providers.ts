// 来源声明的校验：配置对象 -> 校验过的 provider 定义，或者带上 provider 名与出错项的错误。
// 只接受已经实现的来源类型与封装形态，遇到不认识的取值就地抛出。
// 带 source 的 provider 只能再声明 name，用来覆盖被引用方的显示名；其余项由被引用方决定。
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { CatalogDeclaration, CatalogFields, ProviderDeclaration } from './types.ts';

const KNOWN_CATALOG_KINDS = ['http-model-list'];
const KNOWN_ENVELOPES = ['openai-data-array'];
const KNOWN_AUTH_HEADERS = ['bearer'];
const KNOWN_FIELD_NAMES = new Set(['id', 'name', 'contextWindow', 'endpoints']);

function fail(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${where} 必须是一个对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${where} 缺少必填项 ${key}`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${where} 的 ${key} 必须是非空字符串`);
  }
  return value;
}

// 声明的文件名必须落在插件数据目录里，只接受纯文件名。
function dataFileName(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const name = optionalString(source, key, where);
  if (name !== undefined && /[\\/]/.test(name)) {
    return fail(`${where} 的 ${key} 只能是插件数据目录下的文件名：${name}`);
  }
  return name;
}

function parseRequestHeaders(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {};
  const own = asObject(value, `${where} 的 requestHeaders`);
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(own)) {
    if (typeof item !== 'string') {
      return fail(`${where} 的 requestHeaders.${key} 必须是字符串`);
    }
    headers[key] = item;
  }
  return headers;
}

function parseCompat(value: unknown, where: string): ProviderModelConfig['compat'] | undefined {
  if (value === undefined) return undefined;
  asObject(value, `${where} 的 compat`);
  return value as ProviderModelConfig['compat'];
}

function parseFields(value: unknown, where: string): CatalogFields {
  const fieldsWhere = `${where} 的 fields`;
  const own = asObject(value, fieldsWhere);
  for (const key of Object.keys(own)) {
    if (!KNOWN_FIELD_NAMES.has(key)) {
      return fail(`${fieldsWhere} 有不认识的项 ${key}`);
    }
  }
  return {
    id: requiredString(own, 'id', fieldsWhere),
    name: requiredString(own, 'name', fieldsWhere),
    contextWindow: requiredString(own, 'contextWindow', fieldsWhere),
    endpoints: requiredString(own, 'endpoints', fieldsWhere),
  };
}

function parseCatalog(value: unknown, providerId: string): CatalogDeclaration {
  const where = `providers.json 里 provider ${providerId} 的 catalog`;
  const own = asObject(value, where);
  const kind = requiredString(own, 'kind', where);
  if (!KNOWN_CATALOG_KINDS.includes(kind)) {
    return fail(`${where}.kind 不认识 ${kind}（已知：${KNOWN_CATALOG_KINDS.join('、')}）`);
  }
  const envelope = requiredString(own, 'envelope', where);
  if (!KNOWN_ENVELOPES.includes(envelope)) {
    return fail(`${where}.envelope 不认识 ${envelope}（已知：${KNOWN_ENVELOPES.join('、')}）`);
  }
  const authHeader = optionalString(own, 'authHeader', where);
  if (authHeader !== undefined && !KNOWN_AUTH_HEADERS.includes(authHeader)) {
    return fail(
      `${where}.authHeader 不认识 ${authHeader}（已知：${KNOWN_AUTH_HEADERS.join('、')}）`,
    );
  }
  return {
    kind: 'http-model-list',
    url: requiredString(own, 'url', where),
    requestHeaders: parseRequestHeaders(own.requestHeaders, where),
    authHeader: authHeader === undefined ? undefined : 'bearer',
    envelope: 'openai-data-array',
    fields: parseFields(own.fields, where),
  };
}

// 校验 providers.json 的顶层结构，并把 source 引用解析成被引用方的声明。
export function parseProvidersConfig(raw: unknown): Map<string, ProviderDeclaration> {
  const root = asObject(raw, 'providers.json 的顶层');
  const declared = new Map<string, Record<string, unknown>>();
  for (const [providerId, value] of Object.entries(root)) {
    declared.set(providerId, asObject(value, `providers.json 里 provider ${providerId}`));
  }

  const resolved = new Map<string, ProviderDeclaration>();
  const resolving = new Set<string>();

  function referenced(providerId: string, reference: string): Record<string, unknown> {
    const own = declared.get(reference);
    if (!own) {
      return fail(`providers.json 里 provider ${providerId} 引用的来源 ${reference} 不存在`);
    }
    return own;
  }

  function resolve(providerId: string, own: Record<string, unknown>): ProviderDeclaration {
    const done = resolved.get(providerId);
    if (done) return done;
    if (resolving.has(providerId)) {
      return fail(`providers.json 里 provider ${providerId} 的来源引用形成了循环`);
    }
    resolving.add(providerId);

    const reference = own.source;
    let declaration: ProviderDeclaration;
    if (reference === undefined) {
      const where = `providers.json 里 provider ${providerId}`;
      declaration = {
        sourceProviderId: providerId,
        name: requiredString(own, 'name', where),
        baseUrl: requiredString(own, 'baseUrl', where),
        api: requiredString(own, 'api', where),
        compat: parseCompat(own.compat, where),
        catalog: parseCatalog(own.catalog, providerId),
        extras: dataFileName(own, 'extras', where),
        exclusions: dataFileName(own, 'exclusions', where),
      };
    } else {
      if (typeof reference !== 'string' || reference.length === 0) {
        return fail(`providers.json 里 provider ${providerId} 的 source 必须是非空字符串`);
      }
      const extraKeys = Object.keys(own).filter((key) => key !== 'source' && key !== 'name');
      if (extraKeys.length > 0) {
        return fail(
          `providers.json 里 provider ${providerId} 声明了 source，不能再声明 ${extraKeys.join('、')}`,
        );
      }
      const base = resolve(reference, referenced(providerId, reference));
      declaration =
        own.name === undefined
          ? base
          : {
              ...base,
              name: requiredString(own, 'name', `providers.json 里 provider ${providerId}`),
            };
    }

    resolving.delete(providerId);
    resolved.set(providerId, declaration);
    return declaration;
  }

  for (const [providerId, own] of declared) resolve(providerId, own);
  return resolved;
}
