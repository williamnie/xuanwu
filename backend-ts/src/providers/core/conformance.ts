import { providerRegistryError } from "./errors.ts";
import { capabilityMethodChecks, type ExecutorProviderManifest } from "./manifest.ts";
import { PROVIDER_SESSION_VIEW_CONTRACT } from "./sessionView.ts";

/**
 * P2：capability/method conformance（设计 §2.8，fail closed）。
 * 遍历 manifest.capabilities，对每个声明为 true 的 method 检查 provider 实例确实实现：
 * 声明 true 但方法缺失 → 抛 `capability_unsupported`（注册/启动失败）；
 * 声明 false 但方法存在 → 不自动曝光（不做任何提升）。
 *
 * 诊断信息脱敏：只含 provider id、capability 名、method 名，不含配置值/路径/token。
 */
export function checkManifest(manifest: ExecutorProviderManifest, instance: Record<string, unknown>): void {
  // manifest drift：实例自报 id 与 manifest 不一致 → fail closed
  const instanceId = (instance as { id?: unknown }).id;
  if (typeof instanceId === "string" && instanceId !== manifest.id) {
    throw providerRegistryError(
      "capability_unsupported",
      `provider manifest id ${manifest.id} does not match instance id ${instanceId}`
    );
  }
  const missing: Array<{ capability: string; method: string }> = [];
  for (const check of capabilityMethodChecks(manifest.capabilities)) {
    if (typeof instance[check.method] !== "function") {
      missing.push({ capability: check.capability, method: check.method });
    }
  }
  if (missing.length > 0) {
    const detail = missing
      .map((m) => `${m.capability} (missing method ${m.method})`)
      .join("; ");
    throw providerRegistryError(
      "capability_unsupported",
      `provider ${manifest.id} declares capability but method is missing: ${detail}`
    );
  }
  const sessions = manifest.capabilities.sessions;
  if ((sessions?.list || sessions?.read) &&
      manifest.sessionPresentation?.viewContract !== PROVIDER_SESSION_VIEW_CONTRACT) {
    throw providerRegistryError(
      "capability_unsupported",
      `provider ${manifest.id} declares session list/read but does not declare ${PROVIDER_SESSION_VIEW_CONTRACT}`
    );
  }
}
