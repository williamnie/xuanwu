import { upsertAgentSession, type AgentSession } from "../../db/repositories/agentSessions.ts";
import { type Project } from "../../db/repositories/projects.ts";
import { isExecutorProviderId, type ExecutorCapability, type ExecutorProvider, type ExecutorProviderId, type SessionCreateInput, type SessionMessageInput } from "../../providers/types.ts";
import { runtimeRawRef } from "./sessionRuntimeSettings.ts";
import type { ProviderTransport } from "../../providers/core/manifest.ts";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicyRequest } from "../../providers/core/policyContracts.ts";
import { parseExecutionPolicyWrite } from "../../providers/core/policyPersistence.ts";
import { resolveExecutionPolicy } from "../../providers/core/policyResolution.ts";
import { translateLegacyExecutionPolicy } from "../../providers/core/legacyExecutionPolicy.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import type { SessionApiContext, QualifiedSessionRef } from "./sessionApi.model.ts";
import { projectForSession, stringBody, firstNonEmpty, sessionProviders, publicAgentSession } from "./sessionApi.listSessions.ts";

export async function createSession(context: SessionApiContext, body: Record<string, unknown>) {
  const project = projectForSession(context, stringBody(body, "project_id"));
  const providerID = firstNonEmpty(stringBody(body, "provider"), project?.provider ?? "codex");
  const provider = capableProvider(context, providerID, "sessions", "createSession", "", project?.id ?? "");
  const input = withSessionPolicy(provider, sessionCreateInput(body, project, provider.id), "local-user");
  const result = await provider.createSession!(input);
  assertProviderResult(provider.id, result.provider);
  const status = completedOperationStatus(provider.id, input.prompt, result.provider_turn_id ?? result.turn_id ?? "");
  persistSession(context, provider.id, input, result.provider_session_id, result.provider_turn_id ?? "", status);
  return { ...result, id: `${provider.id}:${result.provider_session_id}`, provider: provider.id, status, isRunning: status === "running" };
}

export function capableProvider(
  context: SessionApiContext,
  rawProviderID: string,
  capability: ExecutorCapability,
  method: "createSession" | "listSessions" | "readSession" | "sendSessionMessage",
  sessionKey = "",
  projectID = ""
): ExecutorProvider {
  const providerID = rawProviderID.trim();
  if (!isExecutorProviderId(providerID)) throw new Error(`session provider "${providerID}" 当前 runner 未注册`);
  // 新建会话按所选项目、其余操作按会话所属项目找到它所在的节点。
  const providers = projectID !== ""
    ? providersForProjectID(context.database, context.providers, projectID)
    : sessionProviders(context, sessionKey);
  const provider = providers?.[providerID];
  if (!provider) throw new Error(`provider "${providerID}" 当前 runner 未注册`);
  // 只开放读取的节点不声明 sessions 能力，但读取方法可用。
  const remoteRead = providers !== context.providers && method === "readSession";
  if (!provider.capabilities.includes(capability) && !remoteRead) {
    throw new Error(`provider "${providerID}" 不支持 capability "${capability}"`);
  }
  if (typeof provider[method] !== "function") throw new Error(`provider "${providerID}" 未实现 ${method}`);
  const status = provider.runtimeStatus?.();
  if (status?.ready === false) {
    throw new Error(`provider "${providerID}" 尚未就绪: ${status.reason || "configuration required"}`);
  }
  return provider;
}

export function sessionCreateInput(
  body: Record<string, unknown>,
  project: Project | null,
  provider: ExecutorProviderId
): SessionCreateInput {
  const inheritedPolicy = project?.execution_policy ?? structuredClone(DEFAULT_EXECUTION_POLICY);
  const executionPolicy = explicitExecutionPolicy(body)
    ?? legacyExecutionPolicyBody(body, inheritedPolicy)
    ?? inheritedPolicy;
  return {
    projectId: project?.id,
    ...(provider === "codex" && stringBody(body, "title").trim() ? { title: stringBody(body, "title").trim() } : {}),
    cwd: firstNonEmpty(stringBody(body, "cwd"), project?.cwd ?? ""),
    model: sessionModel(body, project, provider),
    reasoningEffort: stringBody(body, "reasoning_effort"),
    serviceTier: stringBody(body, "service_tier"),
    approvalPolicy: firstNonEmpty(stringBody(body, "approval_policy"), project?.approval_policy ?? ""),
    sandbox: firstNonEmpty(stringBody(body, "sandbox"), project?.sandbox ?? ""),
    executionPolicy,
    prompt: stringBody(body, "prompt")
  };
}

export function explicitExecutionPolicy(body: Record<string, unknown>): ExecutionPolicyRequest | undefined {
  if (!Object.hasOwn(body, "execution_policy") && !Object.hasOwn(body, "execution_policy_json")) return undefined;
  return parseExecutionPolicyWrite(
    Object.hasOwn(body, "execution_policy") ? body.execution_policy : body.execution_policy_json,
    { allowEmpty: false }
  );
}

export function legacyExecutionPolicyBody(
  body: Record<string, unknown>,
  inherited: ExecutionPolicyRequest
): ExecutionPolicyRequest | undefined {
  if (!Object.hasOwn(body, "sandbox") && !Object.hasOwn(body, "approval_policy")) return undefined;
  const translated = translateLegacyExecutionPolicy({
    approvalPolicy: body.approval_policy,
    inherited,
    sandbox: body.sandbox,
    scope: "profile"
  });
  if (translated.unknown.length > 0) {
    throw new Error(`unknown legacy execution policy value for ${translated.unknown.map((item) => item.field).join(", ")}`);
  }
  return translated.policy;
}

export function withSessionPolicy<T extends SessionCreateInput | SessionMessageInput>(
  provider: ExecutorProvider,
  input: T,
  source: "local-user" | "recovery"
): T {
  const capabilities = provider.manifest?.executionPolicy;
  if (!capabilities || !provider.policyAdapter || !input.executionPolicy) return input;
  const runtime = provider.runtimeStatus?.();
  const transport = sessionProviderTransport(provider, runtime?.mode ?? "");
  const policy = resolveExecutionPolicy(input.executionPolicy, {
    cwd: input.cwd ?? "",
    invocationRef: `session:${crypto.randomUUID()}`,
    projectId: input.projectId ?? "",
    providerId: provider.manifest!.id,
    providerVersion: runtime?.version ?? "",
    source,
    transport
  }, capabilities, provider.policyAdapter);
  return { ...input, policy };
}

export function sessionProviderTransport(provider: ExecutorProvider, mode: string): ProviderTransport {
  const transports = provider.manifest?.transports ?? [];
  const mapped = mode.trim() === "cli-fallback" ? "stdio-json" : mode.trim();
  return (transports.includes(mapped as ProviderTransport) ? mapped : transports[0] ?? "sdk") as ProviderTransport;
}

export function parseSessionRef(rawSessionID: string): QualifiedSessionRef {
  const clean = rawSessionID.trim();
  const separator = clean.indexOf(":");
  const provider = separator < 0 ? "codex" : clean.slice(0, separator).trim();
  const sessionId = (separator < 0 ? clean : clean.slice(separator + 1)).trim();
  if (provider === "" || sessionId === "") throw new Error("session ref 无效");
  return { key: `${provider}:${sessionId}`, provider, sessionId };
}

export function publicAgentSessionOrNull(session: AgentSession | null): Record<string, unknown> | null {
  return session ? publicAgentSession(session) : null;
}

export function persistSession(
  context: SessionApiContext,
  provider: ExecutorProviderId,
  input: SessionCreateInput,
  sessionId: string,
  turnId: string,
  status: string
): void {
  if (sessionId === "") return;
  upsertAgentSession(context.database, {
    provider,
    provider_session_id: sessionId,
    project_id: input.projectId ?? "",
    preview: sessionPreview(input.prompt ?? ""),
    raw_ref: runtimeRawRef(input, turnId, provider),
    status
  });
}

export function sessionModel(body: Record<string, unknown>, project: Project | null, provider: ExecutorProviderId): string {
  const explicit = stringBody(body, "model");
  if (explicit) return providerScopedModel(provider, explicit);
  if (project?.provider !== provider) return "";
  return providerScopedModel(provider, project.model);
}

export function providerScopedModel(provider: string, model: string): string {
  const value = model.trim();
  return provider !== "codex" && value === "codex-default" ? "" : value;
}

export function completedOperationStatus(provider: ExecutorProviderId, prompt: string | undefined, turnId: string): string {
  // Codex 与常驻 Claude 会话都是提交即返回，轮的结束由 provider 事件与会话读取收口。
  if (provider !== "codex" && provider !== "claude") return "idle";
  return prompt?.trim() || turnId.trim() ? "running" : "idle";
}

export function isEmptyRolloutError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("rollout at") &&
    (error instanceof Error ? error.message : String(error)).includes(" is empty");
}

export function sessionPreview(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

export function assertProviderResult(expected: ExecutorProviderId, actual: ExecutorProviderId): void {
  if (actual !== expected) throw new Error(`provider result mismatch: expected ${expected}, received ${actual}`);
}
