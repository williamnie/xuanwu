import type { SessionReadInput } from "../types.ts";
import { getSessionInfo as sdkGetSessionInfo, getSessionMessages as sdkGetSessionMessages, listSessions as sdkListSessions, query as sdkQuery, type Options as ClaudeSdkOptions, type Query as ClaudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { ClaudeLiveSession, type ClaudeLiveSubmission } from "./liveSession.ts";
import { inspectClaudeCliAuth } from "./cliProvider.ts";
import { claudeAuthenticationStatus } from "./auth.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import { assertClaudeSessionHistoryIdentity, publicClaudeSessionDetail, publicClaudeSessionSummary, readBoundedClaudeSessionHistory } from "./sessionHistory.ts";
import { type ExecutorProvider, type InterruptInput, type ProviderEvent, type ProviderRecoveryInput, type ProviderRunInput, type ProviderRunResult, type ProviderRuntimeStatus, type SessionCreateInput, type SessionCreateResult, type SessionListInput, type SessionListResult, type SessionMessageInput, type SessionMessageResult, type SessionRef } from "../types.ts";
import { ClaudePermissionBroker } from "./permissionBroker.ts";
import { cleanString } from "../../util/values.ts";
import { PROVIDER, ClaudeSdkProviderOptions, CLAUDE_AGENT_SDK_VERSION, DEFAULT_IDLE_TIMEOUT_MS, ClaudeQueryFactory, ClaudeSessionFunctions } from "./sdkProviderModel.ts";
import { sdkInput } from "./sdkProviderOptions.ts";
import { resolveClaudeSdkExecutable } from "./sdkExecutable.ts";
import { registerClaudeAuthSecrets, assertUsableCwd, sessionMessageResult, numericCursor, normalizeLimit, claudeResumeCommand, processKey } from "./sdkProviderValues.ts";

export class ClaudeSdkExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals"] as const;
  readonly id = PROVIDER;
  readonly interruptScope = "session" as const;
  private readonly live = new Map<string, ClaudeLiveSession>();
  private readonly permissionBroker = new ClaudePermissionBroker();

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: ClaudeSdkProviderOptions = {}) {
    registerClaudeAuthSecrets(config.env);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    return await this.submit(input.prompt, sdkInput(input, this.config, "", `Issue #${input.issueId}`), input.onEvent, "", input).done;
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    return await this.submit(input.prompt, sdkInput(input, this.config, input.session.sessionId), input.onEvent, input.session.sessionId, input).done;
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    assertUsableCwd(input.cwd);
    const prompt = cleanString(input.prompt);
    if (prompt === "") throw new Error("Claude SDK session creation requires a prompt");
    const submission = this.submit(prompt, sdkInput(input, this.config, "", input.title), undefined, "", input);
    await submission.accepted;
    return {
      id: `${PROVIDER}:${submission.sessionId}`,
      provider: PROVIDER,
      provider_session_id: submission.sessionId,
      provider_turn_id: submission.turnId,
      thread_id: submission.sessionId,
      turn_id: submission.turnId
    };
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    const sessionId = cleanString(input.sessionId);
    if (sessionId === "") throw new Error("Claude SDK resume requires a session id");
    const prompt = cleanString(input.prompt);
    if (prompt === "") throw new Error("Claude SDK session message requires a prompt");
    if (cleanString(input.mode) === "steer") {
      const live = this.live.get(sessionId);
      if (!live?.running) throw new Error("当前 session 没有可引导的运行中 turn");
      return sessionMessageResult(sessionId, live.steer(prompt));
    }
    const discovered = cleanString(input.cwd) ? undefined : await this.sessionFunctions().getSessionInfo(sessionId);
    const cwd = cleanString(input.cwd) || cleanString(discovered?.cwd) || cleanString(this.config.cwd);
    assertUsableCwd(cwd);
    const submission = this.submit(prompt, sdkInput({ ...input, cwd }, this.config, sessionId), undefined, sessionId, { ...input, cwd });
    await submission.accepted;
    return sessionMessageResult(sessionId, submission.turnId);
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
    return {
      data: sessions.map((session) => publicClaudeSessionSummary(session, this.isRunning(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string, input: SessionReadInput = {}): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = cleanString(sessionId);
    if (id === "") throw new Error("Claude SDK session id is required");
    const functions = this.sessionFunctions();
    const info = await functions.getSessionInfo(id);
    assertClaudeSessionHistoryIdentity(id, info, []);
    const messages = input.includeTurns === false ? [] : await readBoundedClaudeSessionHistory(
      id, info, functions.getSessionMessages.bind(functions)
    );
    if (!info && messages.length === 0) throw new Error(`Claude SDK session ${id} was not found`);
    assertClaudeSessionHistoryIdentity(id, info, messages);
    const detail = publicClaudeSessionDetail(id, info, messages, this.isRunning(id));
    // 终端接手：先在玄武里中断/释放常驻进程，再用这条命令续写，避免两个进程同时写同一会话。
    return { ...detail, live_process: this.live.get(id)?.alive === true, resume_command: claudeResumeCommand(cleanString(info?.cwd), id) };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const live = this.live.get(input.session.sessionId);
    if (!live || !await live.interrupt(input.reason || "runner interrupt")) {
      throw new Error(`Claude SDK session ${input.session.sessionId} is not active`);
    }
  }

  async stop(): Promise<void> {
    this.permissionBroker.rejectAll("Claude provider stopped while approval was pending");
    for (const live of [...this.live.values()]) live.close("runner shutdown");
    this.live.clear();
  }

  async resolveApproval(requestId: string, decision: import("../types.ts").ApprovalDecision): Promise<void> {
    await this.permissionBroker.resolveApproval(requestId, decision);
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const authentication = claudeAuthenticationStatus(this.config);
    const localAuth = this.config.authMode === "local-cli"
      ? (this.options.authInspector ?? inspectClaudeCliAuth)(this.config)
      : undefined;
    const executableReady = resolveClaudeSdkExecutable() !== "";
    const injectedRuntime = this.options.skipReadinessCheck === true || Boolean(this.options.queryFactory);
    const authConfigured = localAuth ? localAuth.checked && localAuth.logged_in : authentication.configured;
    const authUsable = localAuth ? !localAuth.checked || localAuth.logged_in : authentication.configured;
    const ready = injectedRuntime || (authUsable && executableReady);
    return {
      ready,
      mode: "sdk",
      version: CLAUDE_AGENT_SDK_VERSION,
      active_sessions: [...this.live.values()].filter((live) => live.running).length,
      api_key_configured: this.config.authMode === "environment" && cleanString(this.config.env.ANTHROPIC_API_KEY) !== "",
      auth_configured: authConfigured,
      auth_mode: localAuth ? "local-cli" : authentication.mode,
      auth_source: localAuth ? "local_cli" : authentication.source,
      executable_ready: executableReady,
      ...(authentication.platform_profile ? { platform_profile: authentication.platform_profile } : {}),
      ...(ready ? {} : {
        reason: authUsable
          ? "Claude SDK native executable is unavailable"
          : localAuth?.checked
            ? "Claude CLI local login is unavailable; run `claude auth login` as the service user"
            : authentication.reason || "Claude SDK authentication is not configured"
      })
    };
  }

  private submit(
    prompt: string,
    options: ClaudeSdkOptions,
    onEvent?: (event: ProviderEvent) => void,
    resumeSessionId = "",
    policyInput?: Pick<ProviderRunInput, "cwd" | "policy">
  ): ClaudeLiveSubmission & { sessionId: string } {
    this.assertReady();
    const sessionId = resumeSessionId || cleanString(options.sessionId) ||
      cleanString(this.options.sessionIdFactory?.()) || crypto.randomUUID();
    const invocationRef = `claude-inv-${crypto.randomUUID()}`;
    const policy = policyInput?.policy?.nativeSummary.hostToolGate === true ? policyInput.policy : undefined;
    const submission = this.liveSession(sessionId, resumeSessionId !== "").submit({
      id: crypto.randomUUID(),
      prompt,
      key: processKey(options, Boolean(policy)),
      options,
      onEvent,
      timeoutMs: this.config.timeoutMs,
      ...(policy ? {
        canUseTool: (session: () => SessionRef | undefined) => this.permissionBroker.callback({
          cwd: policyInput!.cwd,
          invocationRef,
          // 会话消息没有 run 级 onEvent，审批事件必须落到全局 eventSink，否则前端收不到审批请求。
          onEvent: (event) => this.emit(event, onEvent),
          policy,
          session: () => session() ?? { provider: PROVIDER, sessionId }
        })
      } : {}),
      rejectApprovals: (reason) => this.permissionBroker.rejectInvocation(invocationRef, reason)
    });
    return { ...submission, sessionId };
  }

  private liveSession(sessionId: string, resumed: boolean): ClaudeLiveSession {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const live = new ClaudeLiveSession(sessionId, {
      emit: (event, onEvent) => this.emit(event, onEvent),
      startQuery: (prompt, options) => this.queryFactory()({ prompt, options }),
      sessionInfo: async (id, cwd) => await this.sessionFunctions().getSessionInfo(id, cwd ? { dir: cwd } : undefined),
      sessionStarted: (id, wasResumed, onEvent) => this.emit(providerSessionStartedEvent(this.id, id, {
        method: wasResumed ? "claude-sdk/session_resumed" : "claude-sdk/session_started",
        metadata: { sdk_transport: "stream" }
      }), onEvent),
      idleTimeoutMs: this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      released: (session) => {
        if (this.live.get(session.sessionId) === session) this.live.delete(session.sessionId);
      }
    }, resumed);
    this.live.set(sessionId, live);
    return live;
  }

  private isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.running === true;
  }

  private emit(event: ProviderEvent, onEvent?: (event: ProviderEvent) => void): void {
    (onEvent ?? this.options.eventSink)?.(event);
  }

  private assertReady(): void {
    const status = this.runtimeStatus();
    if (!status.ready) throw new Error(`${status.reason}; configure Claude environment auth, an Anthropic platform profile, or explicit cli-fallback local auth`);
  }

  private queryFactory(): ClaudeQueryFactory {
    return this.options.queryFactory ?? ((input) => sdkQuery(input as Parameters<typeof sdkQuery>[0]) as ClaudeSdkQuery);
  }

  private sessionFunctions(): ClaudeSessionFunctions {
    return {
      getSessionInfo: this.options.sessionFunctions?.getSessionInfo ?? sdkGetSessionInfo,
      getSessionMessages: this.options.sessionFunctions?.getSessionMessages ?? sdkGetSessionMessages,
      listSessions: this.options.sessionFunctions?.listSessions ?? sdkListSessions
    };
  }
}
