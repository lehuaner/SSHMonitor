/**
 * Provider 注册中心。
 * 每个 Provider 负责一个签到平台，暴露统一接口，供调度中心与前端动态表单使用。
 * 新增 Provider：写一个文件 + 在 server.js 里 registerProvider 一行即可。
 */
const providers = new Map();

/** 注册一个 provider */
export function registerProvider(provider) {
  providers.set(provider.id, provider);
}

/** 按 id 取 provider */
export function getProvider(id) {
  return providers.get(id);
}

/** 列出全部 provider（含 configSchema，供前端动态渲染表单） */
export function listProviders() {
  return [...providers.values()];
}

export function getProviderSchemas() {
  return listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    capabilities: p.capabilities || [],
    configSchema: p.configSchema || [],
  }));
}