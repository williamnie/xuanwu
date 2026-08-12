import type { ProviderCapabilities } from "./manifest.ts";
import type { RegistryEntry } from "./registry.ts";
import type { ProviderRuntimeStatus } from "../types.ts";
import { redactedUserVisibleText } from "../../util/redact.ts";

/**
 * P6：Provider discovery catalog projection。
 * 前端/API 从这里读取唯一 authority（label、capability、可提交性、session actions、native actions），
 * 不再维护静态 PROVIDER_OPTIONS/SESSION_CAPABLE_PROVIDERS 等 authority。
 */

export type ProviderSessionAction = "create" | "resume" | "steer" | "fork" | "interrupt";

export type ProviderCatalogEntry = {
  id: string;
  label: string;
  supportLevel: "experimental" | "preview" | "tested";
  capabilities: ProviderCapabilities;
  enabled: boolean;
  legacy_capabilities: readonly string[];
  state: string;
  /** 可提交（ready 且未 disabled）；not-ready 可见但不可提交 */
  submittable: boolean;
  session_actions: readonly ProviderSessionAction[];
  settings: { settings: readonly unknown[] };
  native_actions: readonly unknown[];
  readiness_reason?: string;
  runtime?: ProviderRuntimeStatus;
};

export function sessionActionsFromCapabilities(capabilities: ProviderCapabilities): readonly ProviderSessionAction[] {
  const actions: ProviderSessionAction[] = [];
  if (capabilities.sessions?.create) actions.push("create");
  if (capabilities.sessions?.resume) actions.push("resume");
  if (capabilities.sessions?.steerWhileRunning) actions.push("steer");
  if (capabilities.sessions?.fork) actions.push("fork");
  if (capabilities.control?.interrupt) actions.push("interrupt");
  return actions;
}

export function catalogEntryFromRegistry(entry: RegistryEntry): ProviderCatalogEntry {
  return {
    id: String(entry.id),
    label: entry.manifest.displayName,
    supportLevel: entry.manifest.supportLevel,
    capabilities: entry.manifest.capabilities,
    enabled: entry.state !== "disabled",
    legacy_capabilities: legacyCapabilities(entry.manifest.capabilities),
    state: entry.state,
    submittable: entry.state === "ready",
    session_actions: sessionActionsFromCapabilities(entry.manifest.capabilities),
    settings: entry.manifest.executionSettings ?? { settings: [] },
    native_actions: entry.manifest.sessionPresentation?.nativeActions ?? [],
    ...(entry.runtimeStatus ? { runtime: entry.runtimeStatus } : {}),
    ...(entry.failure ? { readiness_reason: redactedUserVisibleText(entry.failure.message) } : {})
  };
}

function legacyCapabilities(capabilities: ProviderCapabilities): readonly string[] {
  const out: string[] = ["issue_execution"];
  if (capabilities.sessions?.create || capabilities.sessions?.list || capabilities.sessions?.read) out.push("sessions");
  if (capabilities.sessions?.resume) out.push("resume_session");
  if (capabilities.control?.interrupt) out.push("interrupt");
  if (capabilities.control?.approvals === "host-callback") out.push("approvals");
  if (capabilities.models?.list) out.push("model_list");
  return out;
}
