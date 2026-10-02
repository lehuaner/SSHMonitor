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
    // ★「账号名称」输入框的占位提示由各 provider 自己给（不同平台的命名习惯不同）
    namePlaceholder: p.namePlaceholder || null,
    configSchema: p.configSchema || [],
    // ★卡片「凭证到期」那一行的展示阶梯，由各 provider 自己给。
    //   方案一/方案二只是 Trae 的凭证形态叫法，其它平台（AutoClaw 30 天 RT、
    //   OfficeAce 单次有效 RT、WorkBuddy Cookie 换 Bearer）各有各的口径，
    //   不在这里声明就会串味 —— 前端只按声明渲染，不再硬编码任何平台文案。
    credDisplay: p.credDisplay || null,
  }));
}