import { type ProviderRunInput } from "../types.ts";
import { resolve } from "node:path";
import { PiRpcTransport } from "./rpcTransport.ts";
import { type PiSessionFunctions } from "./sessionHistory.ts";

/**
 * P10：Pi Coding Agent executor（RPC transport，G10 gate 已通过）。
 * - terminal 收敛：`agent_settled`（fully settled，无自动 retry/compaction）为 authoritative terminal；
 * - session：prompt 前持久化 `get_state.sessionId`；recover 用 `--session` 启动后发送 prompt；
 * - interrupt：有界 `abort` 后停止独占 transport；model list：`get_available_models`。
 */

export type PiExecutorProviderOptions = {
  transport?: PiRpcTransport;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionFunctions?: PiSessionFunctions;
  timeoutMs?: number;
  policyExtensionPath?: string;
};

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function boundedPiAbort(transport: PiRpcTransport, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.send({ type: "abort" }).then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeModel(entry: unknown): { id: string; display_name: string } {
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const modelId = String(record.id ?? record.modelId ?? "");
    const provider = String(record.provider ?? "");
    const id = provider && modelId ? `${provider}/${modelId}` : modelId;
    return { id, display_name: String(record.display_name ?? record.name ?? id) };
  }
  return { id: String(entry), display_name: String(entry) };
}

export function modelRecords(value: unknown): Array<Record<string, unknown>> {
  const models = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { models?: unknown }).models)
      ? (value as { models: unknown[] }).models
      : [];
  return models.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

export function piVersion(path?: string): string {
  if (!path) return "";
  try {
    const result = Bun.spawnSync([path, "--version"], { stderr: "ignore", stdout: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
  } catch {
    return "";
  }
}

export function assertPiApprovalPolicy(value: string | undefined): void {
  const policy = value?.trim() ?? "";
  if (policy !== "" && policy !== "never") {
    throw new Error(`Pi Coding Agent does not support host approval policy ${JSON.stringify(policy)}`);
  }
}

export function assertPiLegacyPolicy(input: Pick<ProviderRunInput, "approvalPolicy" | "policy">): void {
  if (!input.policy) assertPiApprovalPolicy(input.approvalPolicy);
}

export function piNativeExecution(
  input: Pick<ProviderRunInput, "policy" | "sandbox">,
  extensionPath: string | undefined
): { tools: readonly string[]; extensions: readonly string[] } {
  const nativeTools = input.policy?.nativeSummary.tools;
  const tools = Array.isArray(nativeTools) && nativeTools.every((tool) => typeof tool === "string")
    ? nativeTools
    : piToolsForSandbox(input.sandbox);
  const approvalBridge = input.policy?.nativeSummary.approvalBridge === true;
  if (!approvalBridge) return { tools, extensions: [] };
  const path = extensionPath?.trim() ?? "";
  if (path === "") throw new Error("Pi approval bridge is unavailable: policy extension path is not configured");
  return { tools, extensions: [path] };
}

export function piToolsForSandbox(value: string | undefined): readonly string[] {
  const sandbox = value?.trim() ?? "";
  if (sandbox === "read-only") return ["read", "grep", "find", "ls"];
  if (sandbox === "danger-full-access") return [];
  throw new Error(
    `Pi Coding Agent cannot enforce sandbox policy ${JSON.stringify(sandbox || "workspace-write")}; choose "read-only" or explicitly choose "danger-full-access"`
  );
}

export async function applyExecutionSettings(transport: PiRpcTransport, model?: string, thinking?: string): Promise<void> {
    const selectedModel = model?.trim();
    if (selectedModel && selectedModel !== "codex-default") {
      const modelsPayload = await transport.send({ type: "get_available_models" });
      const candidates = modelRecords(modelsPayload);
      const match = candidates.find((entry) => {
        const id = String(entry.id ?? entry.modelId ?? "");
        const provider = String(entry.provider ?? "");
        return selectedModel === id || selectedModel === `${provider}/${id}`;
      });
      if (!match) throw new Error(`Pi model ${JSON.stringify(selectedModel)} is not available`);
      await transport.send({
        type: "set_model",
        provider: String(match.provider ?? ""),
        modelId: String(match.id ?? match.modelId ?? "")
      });
    }
    const level = thinking?.trim();
    if (level) await transport.send({ type: "set_thinking_level", level });
  }
