import { redactedUserVisibleText, redactSensitiveText } from "../../util/redact.ts";
import type { ProviderErrorCategory } from "./errors.ts";
import { legacyCapabilitiesFromDetail } from "./manifest.ts";
import type { RegistryEntry, RegistryState } from "./registry.ts";

/** URL userinfo（`user:pass@`）脱敏：现有 redaction registry 不覆盖，P4 status 层补齐。 */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(:[^\s/@]+)?@/gi;

export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO_PATTERN, "$1[redacted]@");
}

function redactStatusText(text: string): string {
  return redactUrlUserinfo(redactedUserVisibleText(text));
}

/**
 * P4：registry-driven System Status projection（设计 §4「status 投影」）。
 * systemStatus 只读消费 registry.list()，不再手写 codex/claude switch；
 * 新测试 Provider 经 factory 注册即可出现在 status。
 *
 * 脱敏规则（验收强制）：
 * - 不含 token/api key（redactSensitiveText 覆盖 env、字段、值）；
 * - 不含完整 credential path（redactedUserVisibleText 折叠绝对路径）；
 * - 不含 URL userinfo/query（redactSensitiveText 的 SECRET_QUERY/BEARER 模式覆盖）。
 */
export type ProviderStatusEntry = {
  id: string;
  label: string;
  role: "executor";
  state: RegistryState;
  enabled: boolean;
  available: boolean;
  ready: boolean;
  supportLevel: "experimental" | "preview" | "tested";
  capabilities: readonly string[];
  authSource?: string;
  runtimeVersion?: string;
  failure?: { category: ProviderErrorCategory; message: string };
};

export function statusFromRegistry(list: readonly RegistryEntry[]): ProviderStatusEntry[] {
  return list.map((entry) => {
    const runtimeStatus = entry.instance?.runtimeStatus?.();
    return {
      id: String(entry.id),
      label: entry.manifest.displayName,
      role: "executor",
      state: entry.state,
      enabled: entry.state !== "disabled",
      available: entry.state === "ready",
      ready: entry.state === "ready",
      supportLevel: entry.manifest.supportLevel,
      capabilities: legacyCapabilitiesFromDetail(entry.manifest.capabilities),
      ...(runtimeStatus?.auth_source ? { authSource: redactStatusText(runtimeStatus.auth_source) } : {}),
      ...(runtimeStatus?.version ? { runtimeVersion: redactStatusText(runtimeStatus.version) } : {}),
      ...(entry.failure
        ? { failure: { category: entry.failure.category, message: redactStatusText(entry.failure.message) } }
        : {})
    };
  });
}
