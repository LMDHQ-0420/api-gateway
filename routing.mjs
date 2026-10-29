import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class RoutingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function strings(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} 必须是非空字符串的数组`);
  }
  return value;
}

export function prepareProviders(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('providers 必须是非空数组');
  const ids = new Set();
  return definitions.map(definition => {
    const { id, origin: originText, basePath = '/v1', auth = 'bearer', enabled = true } = definition;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error('厂商 id 必须唯一且仅包含小写字母、数字、_、-');
    ids.add(id);
    const origin = new URL(originText);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error(`厂商 ${id} 的 origin 必须仅包含协议、主机和可选端口`);
    }
    if (typeof enabled !== 'boolean' || !['bearer', 'x-api-key'].includes(auth)) {
      throw new Error(`厂商 ${id} 的 enabled 或 auth 配置无效`);
    }
    const validPath = path => typeof path === 'string' && /^\/(?!\/)[^?#\\]*$/.test(path) && !path.endsWith('/') && !path.split('/').some(part => part === '.' || part === '..');
    if (!validPath(basePath)) throw new Error(`厂商 ${id} 的 basePath 配置无效`);
    const messagesBasePath = definition.messagesBasePath === undefined
      ? (id === 'anthropic' ? '/v1' : null) : definition.messagesBasePath;
    if (messagesBasePath !== null && !validPath(messagesBasePath)) {
      throw new Error(`厂商 ${id} 的 messagesBasePath 配置无效`);
    }
    const messagesAuth = definition.messagesAuth ?? auth;
    if (!['bearer', 'x-api-key'].includes(messagesAuth)) throw new Error(`厂商 ${id} 的 messagesAuth 配置无效`);
    const modelsPath = definition.modelsPath ?? `${basePath}/models`;
    if (typeof modelsPath !== 'string' || !modelsPath.startsWith('/') || modelsPath.startsWith('//') || /[#\\\r\n]/.test(modelsPath)) {
      throw new Error(`厂商 ${id} 的 modelsPath 必须是官方模型列表的绝对路径`);
    }
    const nativePrefixes = strings(definition.nativePrefixes ?? [], 'nativePrefixes');
    if (!nativePrefixes.every(validPath)) throw new Error(`厂商 ${id} 的 nativePrefixes 配置无效`);
    const headers = definition.headers ?? {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error(`厂商 ${id} 的 headers 必须是对象`);
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[a-z0-9-]+$/.test(name) || typeof value !== 'string' || /[^\x20-\x7e]/.test(value) ||
          ['host', 'authorization', 'x-api-key', 'x-goog-api-key', 'connection', 'content-length', 'transfer-encoding', 'cookie'].includes(name)) {
        throw new Error(`厂商 ${id} 的 headers 包含不支持的字段`);
      }
    }
    const retryStatuses = definition.retryStatuses ?? [401, 402, 403, 408, 429];
    if (!Array.isArray(retryStatuses) || retryStatuses.some(status => !Number.isInteger(status) || status < 400 || status > 599)) {
      throw new Error(`厂商 ${id} 的 retryStatuses 必须是 HTTP 错误状态码数组`);
    }
    return { ...definition, id, origin, basePath, auth, enabled, headers, nativePrefixes, retryStatuses, modelsPath, messagesBasePath, messagesAuth,
      models: strings(definition.models ?? [], 'models'),
      modelPrefixes: strings(definition.modelPrefixes ?? [], 'modelPrefixes'),
    };
  });
}

export async function loadProviderDefinitions(configFile, parseKeys, { legacyKeysFile = 'keys.txt', legacyOrigin } = {}) {
  const configPath = resolve(configFile);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  // 先验证配置，即使没有启用厂商也不会静默接受错误地址或规则。
  prepareProviders(config.providers);
  const definitions = [];
  for (const provider of config.providers) {
    let keys = [];
    if (provider.enabled !== false) {
      if (typeof provider.keysFile !== 'string' || !provider.keysFile.trim()) throw new Error(`厂商 ${provider.id} 缺少 keysFile`);
      const readKeys = async filename => {
        try { return parseKeys(await readFile(filename, 'utf8'), { allowEmpty: true }); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      };
      keys = await readKeys(resolve(dirname(configPath), provider.keysFile));
      // 兼容原版本根目录 keys.txt，不会覆盖已有 GLM 专属池。
      if (!keys.length && provider.id === 'glm' && legacyKeysFile) {
        keys = await readKeys(resolve(legacyKeysFile));
      }
    }
    definitions.push({ ...provider, keys,
      ...(provider.id === 'glm' && legacyOrigin ? { origin: legacyOrigin } : {}),
    });
  }
  return definitions;
}

function selectUnique(candidates, code) {
  if (candidates.length > 1) {
    throw new RoutingError(400, code, '匹配到多个厂商，请在配置中消除冲突，或使用 /providers/<厂商>/ URL。',
      { providers: candidates.map(item => item.id) });
  }
  return candidates[0];
}

function modelProvider(model, providers) {
  const name = model.toLowerCase();
  const exact = providers.filter(provider => provider.models.some(item => item.toLowerCase() === name));
  if (exact.length) return selectUnique(exact, 'ambiguous_model');
  const discovered = providers.filter(provider => provider.discoveredModels?.has(name));
  if (discovered.length) return selectUnique(discovered, 'ambiguous_model');
  const matches = providers.flatMap(provider => provider.modelPrefixes
    .filter(prefix => name.startsWith(prefix.toLowerCase()))
    .map(prefix => ({ provider, length: prefix.length })));
  const longest = Math.max(0, ...matches.map(item => item.length));
  return selectUnique([...new Set(matches.filter(item => item.length === longest).map(item => item.provider))], 'ambiguous_model');
}

function messagePath(path, base = '/v1') {
  return path === `${base}/messages` || path.startsWith(`${base}/messages/`);
}

function routeProviderPath(provider, path, query, preserveNative = false) {
  if (messagePath(path, '/v1/v1')) {
    throw new RoutingError(400, 'invalid_anthropic_base_url', 'Claude Code 的 ANTHROPIC_BASE_URL 应填写网关根地址，不要在末尾添加 /v1。');
  }
  if (messagePath(path)) {
    if (!provider.messagesBasePath) {
      throw new RoutingError(501, 'unsupported_protocol', '该厂商未配置官方 Anthropic Messages 接口，请使用 OpenAI 接口或配置 messagesBasePath。',
        { provider: provider.id });
    }
    return { provider, path: provider.messagesBasePath + path.slice(3) + query, protocol: 'anthropic' };
  }
  if (provider.messagesBasePath && messagePath(path, provider.messagesBasePath)) {
    return { provider, path: path + query, protocol: 'anthropic' };
  }
  return { provider, path: !preserveNative && (path === '/v1' || path.startsWith('/v1/'))
    ? provider.basePath + path.slice(3) + query : path + query };
}

export function routeRequest(rawUrl, headers, body, providers) {
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : rawUrl.slice(queryIndex);
  const enabled = providers.filter(provider => provider.enabled);
  const scoped = /^\/providers\/([a-z][a-z0-9_-]*)(\/.*)?$/.exec(path);
  if (scoped) {
    const provider = enabled.find(item => item.id === scoped[1]);
    if (!provider) throw new RoutingError(404, 'unknown_provider', '该厂商不存在或已禁用。');
    // 专属 URL 固定厂商；标准 Messages 路径映射，其余官方路径原样转发。
    return routeProviderPath(provider, scoped[2] || '/', query, true);
  }
  if (path.startsWith('/providers/')) throw new RoutingError(404, 'unknown_provider', '厂商 URL 格式不正确。');

  const native = selectUnique(enabled.filter(provider => provider.nativePrefixes.some(prefix =>
    path === prefix || path.startsWith(prefix + '/')) || (provider.messagesBasePath &&
      provider.messagesBasePath !== '/v1' && messagePath(path, provider.messagesBasePath))), 'ambiguous_path');
  let model;
  if (body.length && /(?:^|\/)json(?:\s*;|$)|\+json(?:\s*;|$)/i.test(headers['content-type'] || '')) {
    let data;
    try { data = JSON.parse(body.toString('utf8')); }
    catch { throw new RoutingError(400, 'invalid_json', '请求体不是有效 JSON。'); }
    model = data?.model;
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      throw new RoutingError(400, 'invalid_model', 'model 必须是非空字符串。');
    }
  }
  const matched = model ? modelProvider(model, enabled) : undefined;
  if (native && matched && native !== matched) {
    throw new RoutingError(400, 'provider_path_mismatch', '模型所属厂商与官方路径不一致；自动分流请使用 /v1/ 路径。');
  }
  if (model && !matched && !native) {
    throw new RoutingError(400, 'unknown_model', '无法确定此模型的官方厂商，请配置 models/modelPrefixes，或使用厂商专属 URL。');
  }
  const provider = matched || native;
  if (!provider) {
    throw new RoutingError(400, 'provider_required', '自动分流需要 JSON 请求体中的 model；不带 model 的接口请使用 /providers/<厂商>/官方路径。');
  }
  return routeProviderPath(provider, path, query, Boolean(native));
}
