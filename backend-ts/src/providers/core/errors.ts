/**
 * P2：typed provider errors（设计 §2.6）。
 * 所有 registry/conformance 错误带 `category`，便于上层按类别路由；
 * 错误 message 必须脱敏：不包含配置值、路径、token、secret。
 */
export type ProviderErrorCategory =
  | "invalid_id" // provider ID 格式非法（branded ProviderId 校验失败）
  | "duplicate_id" // 同一 ID 重复注册
  | "unknown_provider" // getReady/describe 查询未注册 ID
  | "capability_unsupported" // 声明 capability 但方法缺失（conformance fail closed）
  | "not_ready" // 已实例化但 CLI/SDK 不可用
  | "disabled" // config 显式禁用
  | "config_invalid" // factory.parseConfig 失败
  | "startup_failed" // create/conformance 阶段失败
  | "stop_failed" // stopAll 中单个 provider stop 失败（有界容错）
  | "not_found"; // describe 未找到

export class ProviderRegistryError extends Error {
  readonly category: ProviderErrorCategory;
  constructor(category: ProviderErrorCategory, message: string) {
    super(message);
    this.name = "ProviderRegistryError";
    this.category = category;
  }
}

export function providerRegistryError(category: ProviderErrorCategory, message: string): ProviderRegistryError {
  return new ProviderRegistryError(category, message);
}
