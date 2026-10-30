import type { SessionReadInput } from "../types.ts";
import type { ExecutorCapability, ExecutorProvider, InterruptInput, ProviderRecoveryInput, ProviderRunInput, ProviderRunResult, ProviderRuntimeStatus, SessionCreateInput, SessionCreateResult, SessionListInput, SessionListResult, SessionMessageInput, SessionMessageResult, SessionRef } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { createQoderSdkFacade, type QoderRunOptions, type QoderSdkFacade } from "./sdkFacade.ts";
import { QoderPermissionBroker } from "./permissionBroker.ts";
import { probeQoderRuntime } from "./runtime.ts";
import { assertQoderSessionHistoryIdentity, defaultQoderSessionFunctions, publicQoderSessionDetail, publicQoderSessionSummary, readQoderSessionHistory, type QoderSessionFunctions } from "./sessionHistory.ts";
import { cleanString } from "../../util/values.ts";
import { executeQoderInvocation } from "./providerInvocation.ts";
import { type ActiveInvocation, type QoderExecutorProviderOptions, required, requiredSession, numericCursor, normalizeLimit, qoderModelView, QODER_STATIC_MODEL_SUGGESTIONS, redactModelError } from "./providerModel.ts";

export class QoderExecutorProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
  readonly interruptScope = "session" as const;
  private readonly facade: QoderSdkFacade;
  private readonly permissionBroker: QoderPermissionBroker;
  private readonly active = new Map<string, ActiveInvocation>();

  constructor(
    private readonly config: ProviderRuntimeConfig,
    private readonly options: QoderExecutorProviderOptions = {}
  ) {
    this.facade = options.facade ?? createQoderSdkFacade(config);
    this.permissionBroker = new QoderPermissionBroker({ timeoutMs: options.approvalTimeoutMs });
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const sessionId = cleanString(this.options.sessionIdFactory?.()) || crypto.randomUUID();
    return await this.execute(input, { sessionId });
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const sessionId = required(input.session.sessionId, "Qoder recovery session id");
    return await this.execute(input, { resume: sessionId }, sessionId);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const result = await this.execute({
      issueId: 0,
      projectId: input.projectId ?? "",
      cwd: input.cwd,
      prompt: input.prompt ?? "",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      policy: input.policy,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox
    }, { sessionId: cleanString(this.options.sessionIdFactory?.()) || crypto.randomUUID() });
    const session = requiredSession(result);
    return {
      id: session.sessionId,
      provider: this.id,
      provider_session_id: session.sessionId,
      provider_turn_id: session.turnId,
      thread_id: session.sessionId,
      turn_id: session.turnId
    };
  }

  async listSessions(input: SessionListInput = {}): Promise<SessionListResult> {
    this.assertReady();
    const offset = numericCursor(input.cursor);
    const limit = normalizeLimit(input.limit);
    const sessions = await this.sessionFunctions().listSessions({
      ...(cleanString(input.cwd) ? { dir: cleanString(input.cwd) } : {}),
      limit,
      offset
    });
    if (!Array.isArray(sessions)) throw new Error("Qoder session list returned malformed history");
    return {
      data: sessions.map((session) => publicQoderSessionSummary(session, this.active.has(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string, input: SessionReadInput = {}): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = required(sessionId, "Qoder session id");
    const functions = this.sessionFunctions();
    const info = await functions.getSessionInfo(id);
    const history = input.includeTurns === false
      ? { messages: [], truncated: false }
      : await readQoderSessionHistory(functions, id, cleanString(info?.cwd));
    if (!info && history.messages.length === 0) throw new Error(`Qoder session ${id} was not found`);
    assertQoderSessionHistoryIdentity(id, info, history.messages);
    return publicQoderSessionDetail(id, info, history.messages, {
      extensions: this.sessionRuntimeExtensions(),
      running: this.active.has(id),
      truncated: history.truncated
    });
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    this.assertReady();
    const sessionId = required(input.sessionId, "Qoder resume session id");
    if (cleanString(input.mode) === "steer") {
      throw new Error('provider "qoder" does not support live steer; interrupt or resume the session instead');
    }
    const prompt = required(input.prompt, "Qoder session message prompt");
    const functions = this.sessionFunctions();
    const historyOptions = cleanString(input.cwd) ? { dir: cleanString(input.cwd) } : {};
    const info = await functions.getSessionInfo(sessionId, historyOptions);
    if (!info) throw new Error(`Qoder session ${sessionId} was not found; refusing to create an empty replacement`);
    const history = await functions.getSessionMessages(sessionId, {
      ...historyOptions,
      includeSystemMessages: true,
      limit: 1,
      offset: 0
    });
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(`Qoder session ${sessionId} history is empty; refusing to create an empty replacement`);
    }
    assertQoderSessionHistoryIdentity(sessionId, info, history);
    const cwd = cleanString(input.cwd) || cleanString(info.cwd) || cleanString(this.config.cwd);
    const result = await this.execute({
      issueId: 0,
      projectId: input.projectId ?? "",
      cwd,
      prompt,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      policy: input.policy,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox
    }, { resume: sessionId }, sessionId);
    const session = requiredSession(result);
    const turnId = required(session.turnId, "Qoder resumed result message ref");
    return {
      provider: this.id,
      provider_session_id: session.sessionId,
      sessionId: session.sessionId,
      turn_id: turnId
    };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const active = this.lookup(input.session);
    if (!active) throw new Error(`Qoder session ${input.session.sessionId} is not active`);
    active.interrupted = true;
    this.permissionBroker.rejectInvocation(active.invocationRef, "Qoder invocation interrupted while approval was pending");
    await this.facade.interrupt(active.invocationRef);
  }

  async listModels(): Promise<unknown> {
    this.assertReady();
    try {
      return (await this.facade.listModels()).map(qoderModelView);
    } catch (error) {
      return QODER_STATIC_MODEL_SUGGESTIONS.map((id) => ({
        displayName: id,
        id,
        model: id,
        source: "static_suggestion",
        verified: false,
        warning: "账号模型发现失败；请从 Qoder 静态建议中选择",
        discovery_error: redactModelError(error)
      }));
    }
  }

  async resolveApproval(requestId: string, decision: import("../types.ts").ApprovalDecision): Promise<void> {
    await this.permissionBroker.resolveApproval(requestId, decision);
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const status = { ...(this.options.readiness ?? probeQoderRuntime(this.config)).status };
    status.active_sessions = this.facade.activeCount();
    return status;
  }

  processLeases() {
    return this.facade.processLeases();
  }

  async stop(): Promise<void> {
    this.permissionBroker.rejectAll();
    await this.facade.close();
    this.active.clear();
  }

  private execute(input: ProviderRunInput, sessionOptions: Pick<QoderRunOptions, "resume" | "sessionId">, resumeAlias = ""): Promise<ProviderRunResult> {
    return executeQoderInvocation({
      options: this.options, facade: this.facade, permissionBroker: this.permissionBroker,
      track: (active, alias) => this.track(active, alias),
      untrack: active => this.untrack(active)
    }, input, sessionOptions, resumeAlias);
  }

  private track(active: ActiveInvocation, alias: string): void {
    const key = cleanString(alias);
    if (!key || active.aliases.has(key)) return;
    const existing = this.active.get(key);
    if (existing && existing !== active) throw new Error(`Qoder active query alias ${key} is already in use`);
    this.active.set(key, active);
    active.aliases.add(key);
  }

  private untrack(active: ActiveInvocation): void {
    for (const alias of active.aliases) {
      if (this.active.get(alias) === active) this.active.delete(alias);
    }
    active.aliases.clear();
  }

  private lookup(session: SessionRef): ActiveInvocation | undefined {
    return this.active.get(cleanString(session.sessionId)) ??
      (session.turnId ? this.active.get(cleanString(session.turnId)) : undefined);
  }

  private assertReady(): void {
    const status = this.runtimeStatus();
    if (!status.ready) throw new Error(status.reason || "Qoder runtime is unavailable");
  }

  private sessionFunctions(): QoderSessionFunctions {
    return {
      getSessionInfo: this.options.sessionFunctions?.getSessionInfo ?? defaultQoderSessionFunctions.getSessionInfo,
      getSessionMessages: this.options.sessionFunctions?.getSessionMessages ?? defaultQoderSessionFunctions.getSessionMessages,
      listSessions: this.options.sessionFunctions?.listSessions ?? defaultQoderSessionFunctions.listSessions
    };
  }

  private sessionRuntimeExtensions(): Record<string, unknown> {
    const status = this.runtimeStatus();
    const platform = status.platform_profile ?? {};
    return {
      provider_version: status.version,
      sdk_version: cleanString(platform.sdk_version),
      cli_version: cleanString(platform.cli_version),
      protocol_version: cleanString(platform.protocol_version)
    };
  }
}

export { type QoderInvocationHost, executeQoderInvocation } from "./providerInvocation.ts";
export { type QoderExecutorProviderOptions } from "./providerModel.ts";
