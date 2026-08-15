import type {
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  ProviderRuntimeStatus,
  SessionCreateInput,
  SessionCreateResult,
  SessionListInput,
  SessionListResult,
  SessionMessageInput,
  SessionMessageResult,
  SessionRef
} from "../types.ts";
import { ProviderInterruptedError } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { projectQoderMessage, qoderFailureEvent, qoderInterruptedEvent } from "./events.ts";
import {
  createQoderSdkFacade,
  QoderExecutionError,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import { QoderPermissionBroker } from "./permissionBroker.ts";
import { probeQoderRuntime, type QoderRuntimeProbe } from "./runtime.ts";
import {
  assertQoderSessionHistoryIdentity,
  defaultQoderSessionFunctions,
  publicQoderSessionDetail,
  publicQoderSessionSummary,
  readQoderSessionHistory,
  type QoderSessionFunctions
} from "./sessionHistory.ts";

const SYSTEM_PROMPT = "You are executing a Xuanwu-managed Issue. Follow the Issue prompt and report only verified outcomes.";

export type QoderExecutorProviderOptions = {
  approvalTimeoutMs?: number;
  facade?: QoderSdkFacade;
  invocationIdFactory?: () => string;
  readiness?: QoderRuntimeProbe;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<QoderSessionFunctions>;
};

type ActiveInvocation = {
  aliases: Set<string>;
  invocationRef: string;
  interrupted: boolean;
  messageRef: string;
  sessionObserved: boolean;
  sessionRef: string;
  terminalProjected: boolean;
};

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
    const sessionId = clean(this.options.sessionIdFactory?.()) || crypto.randomUUID();
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
    }, { sessionId: clean(this.options.sessionIdFactory?.()) || crypto.randomUUID() });
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
      ...(clean(input.cwd) ? { dir: clean(input.cwd) } : {}),
      limit,
      offset
    });
    if (!Array.isArray(sessions)) throw new Error("Qoder session list returned malformed history");
    return {
      data: sessions.map((session) => publicQoderSessionSummary(session, this.active.has(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = required(sessionId, "Qoder session id");
    const functions = this.sessionFunctions();
    const info = await functions.getSessionInfo(id);
    const history = await readQoderSessionHistory(functions, id, clean(info?.cwd));
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
    if (clean(input.mode) === "steer") {
      throw new Error('provider "qoder" does not support live steer; interrupt or resume the session instead');
    }
    const prompt = required(input.prompt, "Qoder session message prompt");
    const functions = this.sessionFunctions();
    const historyOptions = clean(input.cwd) ? { dir: clean(input.cwd) } : {};
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
    const cwd = clean(input.cwd) || clean(info.cwd) || clean(this.config.cwd);
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

  private async execute(
    input: ProviderRunInput,
    sessionOptions: Pick<QoderRunOptions, "resume" | "sessionId">,
    resumeAlias = ""
  ): Promise<ProviderRunResult> {
    const invocationRef = clean(this.options.invocationIdFactory?.()) || `qoder-inv-${crypto.randomUUID()}`;
    const active: ActiveInvocation = {
      aliases: new Set(),
      interrupted: false,
      invocationRef,
      messageRef: "",
      sessionObserved: false,
      sessionRef: clean(resumeAlias) || clean(sessionOptions.sessionId),
      terminalProjected: false
    };
    this.track(active, invocationRef);
    if (active.sessionRef) this.track(active, active.sessionRef);
    const options: QoderRunOptions = {
      ...sessionOptions,
      approvalPolicy: input.approvalPolicy,
      canUseTool: this.permissionBroker.callback({
        approvalPolicy: input.approvalPolicy,
        cwd: input.cwd,
        invocationRef,
        onEvent: input.onEvent,
        policy: input.policy,
        sandbox: input.sandbox,
        session: () => active.sessionRef
          ? { provider: "qoder", sessionId: active.sessionRef, ...(active.messageRef ? { turnId: active.messageRef } : {}) }
          : undefined
      }),
      cwd: input.cwd,
      invocationKey: invocationRef,
      model: input.model,
      policy: input.policy,
      reasoningEffort: input.reasoningEffort,
      sandbox: input.sandbox,
      systemPrompt: SYSTEM_PROMPT
    };
    try {
      const outcome = await this.facade.run(input.prompt, options, (message, context) => {
        const event = projectQoderMessage(message, {
          interrupted: context.interrupted || active.interrupted,
          invocationRef,
          resume: clean(sessionOptions.resume) !== "",
          usage: context.usage
        });
        const sessionRef = clean(event.session?.sessionId);
        if (sessionRef) {
          active.sessionObserved = true;
          if (active.sessionRef && active.sessionRef !== sessionRef) {
            throw new Error(`Qoder invocation ${invocationRef} returned mismatched session ${sessionRef}`);
          }
          active.sessionRef = sessionRef;
          this.track(active, sessionRef);
        }
        const messageRef = clean(event.session?.turnId);
        if (messageRef) {
          active.messageRef = messageRef;
          this.track(active, messageRef);
        }
        if (event.runEvent?.terminal) active.terminalProjected = true;
        input.onEvent?.(event);
      });
      if (outcome.terminal === "interrupted" || outcome.terminal === "cancelled") {
        if (!active.terminalProjected) {
          input.onEvent?.(qoderInterruptedEvent(invocationRef, outcome.sessionId || active.sessionRef, outcome.messageRef));
        }
        throw new ProviderInterruptedError("Qoder query interrupted");
      }
      return qoderRunResult(outcome);
    } catch (error) {
      if (error instanceof ProviderInterruptedError) throw error;
      if (error instanceof QoderExecutionError && error.details.code === "interrupted") {
        input.onEvent?.(qoderInterruptedEvent(invocationRef, active.sessionRef, active.messageRef));
        throw new ProviderInterruptedError(error.message);
      }
      if (error instanceof QoderExecutionError) {
        // result error 已由 message adapter 投影；SDK/process/no-result failure 需在此补 terminal。
        if (!active.terminalProjected) {
          input.onEvent?.(qoderFailureEvent({
            ...error.details,
            sessionId: active.sessionObserved ? error.details.sessionId : ""
          }, invocationRef));
        }
        throw error;
      }
      const wrapped = new QoderExecutionError({
        category: "sdk",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        sessionId: active.sessionObserved ? active.sessionRef : ""
      });
      input.onEvent?.(qoderFailureEvent(wrapped.details, invocationRef));
      throw wrapped;
    } finally {
      this.untrack(active);
    }
  }

  private track(active: ActiveInvocation, alias: string): void {
    const key = clean(alias);
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
    return this.active.get(clean(session.sessionId)) ??
      (session.turnId ? this.active.get(clean(session.turnId)) : undefined);
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
      sdk_version: clean(platform.sdk_version),
      cli_version: clean(platform.cli_version),
      protocol_version: clean(platform.protocol_version)
    };
  }
}

const QODER_STATIC_MODEL_SUGGESTIONS = ["auto", "ultimate", "performance", "efficient", "lite"] as const;

function qoderModelView(model: import("@qoder-ai/qoder-agent-sdk").ModelInfo): Record<string, unknown> {
  const id = clean(model.value);
  const efforts = Array.isArray(model.efforts) ? model.efforts.map(clean).filter(Boolean) : [];
  return {
    displayName: clean(model.displayName) || id,
    id,
    model: id,
    isDefault: model.isDefault === true,
    source: "qoder_account_live",
    verified: true,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    ...(clean(model.defaultEffort) ? { defaultReasoningEffort: clean(model.defaultEffort) } : {}),
    ...(model.priceFactor === undefined ? {} : { creditsMultiplier: model.priceFactor })
  };
}

function redactModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).slice(0, 240);
}

function qoderRunResult(outcome: QoderQueryResult): ProviderRunResult {
  const sessionId = required(outcome.sessionId, "Qoder result session id");
  const messageRef = required(outcome.messageRef, "Qoder result message ref");
  return {
    runId: required(outcome.invocationRef, "Qoder invocation ref"),
    session: { provider: "qoder", sessionId, turnId: messageRef }
  };
}

function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session) throw new Error("Qoder execution completed without a session ref");
  return result.session;
}

function required(value: unknown, label: string): string {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericCursor(value: string | undefined): number {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return 50;
  return Math.min(value!, 100);
}
