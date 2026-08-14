import type { ProviderId } from "../types.ts";
import type { ProviderExecutionPolicyCapabilities } from "./policyContracts.ts";

/**
 * P2：结构化能力模型（计划 §8.4）。
 * 保留粗粒度 capability name 以兼容当前消费者，同时增加结构化 detail；
 * 旧 `ExecutorCapability[]` 由 detail 确定性投影，在一个兼容窗口内保留。
 */
export type ProviderCapabilities = {
  issueExecution: true;
  sessions?: {
    create?: boolean;
    list?: boolean;
    read?: boolean;
    resume?: boolean;
    steerWhileRunning?: boolean;
    fork?: boolean;
    export?: boolean;
  };
  control?: { interrupt?: boolean; approvals?: "none" | "host-callback" | "native" };
  models?: { list?: boolean; switchDuringSession?: boolean };
  usage?: { tokens?: "attempt" | "session-total"; money?: "provider-reported" | "derived" };
};

export type ProviderSupportLevel = "experimental" | "preview" | "tested";

export type ProviderTransport = "rpc" | "stdio-json" | "stream-json" | "sdk" | "acp";

export type ProviderProcessObservability = "none" | "lease";

/** P6：首版 setting descriptor——仅 string/enum/boolean/secret-ref（计划 §25.4 决策 6）。 */
export type ProviderSettingDescriptor =
  | { kind: "string"; key: string; label: string; placeholder?: string; secret?: false }
  | { kind: "enum"; key: string; label: string; options: Array<{ value: string; label: string }> }
  | { kind: "boolean"; key: string; label: string }
  | { kind: "secret-ref"; key: string; label: string };

export type ProviderSettingsDescriptor = { settings: readonly ProviderSettingDescriptor[] };

/** P6：native action（如 Codex "Open in Codex App"）经 manifest action 提供，非通用 capability。 */
export type ProviderNativeAction = {
  id: string;
  label: string;
  kind: "open-in-app" | "link";
  url?: string;
};

/**
 * P2：ExecutorProviderManifest（设计 §2.4 完整字段表）。
 * `id` 为 branded ProviderId，注册时由 registry 校验唯一性与格式。
 */
export type ExecutorProviderManifest = {
  id: ProviderId;
  displayName: string;
  supportLevel: ProviderSupportLevel;
  transports: readonly ProviderTransport[];
  capabilities: ProviderCapabilities;
  processObservability?: ProviderProcessObservability;
  executionPolicy?: ProviderExecutionPolicyCapabilities;
  /** P6：Provider-specific settings descriptor（renderer 用） */
  executionSettings?: ProviderSettingsDescriptor;
  /** P6：session presentation（空 Session 支持 + native action） */
  sessionPresentation?: {
    emptySession?: boolean;
    nativeActions?: readonly ProviderNativeAction[];
    /** Adapter 的 list/read 输出已经通过 Core Session View builder 归一化。 */
    viewContract?: "xw.provider-session.v1";
  };
};

/** P2：capability 声明 → 校验方法名 的确定性投影（conformance 用）。 */
export type CapabilityMethodCheck = {
  capability: string;
  required: boolean;
  method: string;
};

export function capabilityMethodChecks(capabilities: ProviderCapabilities): readonly CapabilityMethodCheck[] {
  const checks: CapabilityMethodCheck[] = [{ capability: "issueExecution", required: true, method: "run" }];
  const sessions = capabilities.sessions;
  if (sessions?.create) checks.push({ capability: "sessions.create", required: true, method: "createSession" });
  if (sessions?.list) checks.push({ capability: "sessions.list", required: true, method: "listSessions" });
  if (sessions?.read) checks.push({ capability: "sessions.read", required: true, method: "readSession" });
  if (sessions?.resume) checks.push({ capability: "sessions.resume", required: true, method: "recover" });
  if (sessions?.fork) checks.push({ capability: "sessions.fork", required: true, method: "forkSession" });
  const control = capabilities.control;
  if (control?.interrupt) checks.push({ capability: "control.interrupt", required: true, method: "interrupt" });
  if (control?.approvals === "host-callback")
    checks.push({ capability: "control.approvals", required: true, method: "resolveApproval" });
  const models = capabilities.models;
  if (models?.list) checks.push({ capability: "models.list", required: true, method: "listModels" });
  return checks;
}

/** P2：legacy `ExecutorCapability[]` → 结构化 detail 的确定性投影（兼容窗口用）。 */
export function capabilityDetailFromLegacy(legacy: readonly string[]): ProviderCapabilities {
  const has = (c: string) => legacy.includes(c);
  return {
    issueExecution: true,
    sessions: {
      create: has("sessions"),
      list: has("sessions"),
      read: has("sessions"),
      resume: has("resume_session"),
      steerWhileRunning: false,
      fork: false,
      export: false
    },
    control: { interrupt: has("interrupt"), approvals: has("approvals") ? "host-callback" : "none" },
    models: { list: has("model_list"), switchDuringSession: false },
    usage: { tokens: "attempt", money: "provider-reported" }
  };
}

/** P4：结构化 detail → legacy `ExecutorCapability[]` 的确定性投影（§8.4，兼容窗口用）。 */
export function legacyCapabilitiesFromDetail(capabilities: ProviderCapabilities): readonly string[] {
  const out: string[] = ["issue_execution"];
  if (capabilities.sessions?.create || capabilities.sessions?.list || capabilities.sessions?.read) out.push("sessions");
  if (capabilities.sessions?.resume) out.push("resume_session");
  if (capabilities.control?.interrupt) out.push("interrupt");
  if (capabilities.control?.approvals === "host-callback") out.push("approvals");
  if (capabilities.models?.list) out.push("model_list");
  return out;
}
