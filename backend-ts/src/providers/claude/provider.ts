import type { SessionReadInput } from "../types.ts";
import {
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query as sdkQuery,
  type Options as ClaudeSdkOptions,
  type GetSessionMessagesOptions,
  type Query as ClaudeSdkQuery,
  type SDKSessionInfo,
  type SessionMessage
} from "@anthropic-ai/claude-agent-sdk";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { AppEvent } from "../../events/bus.ts";
import { ClaudeLiveSession, type ClaudeLiveSubmission } from "./liveSession.ts";
import {
  ClaudeCliExecutorProvider,
  inspectClaudeCliAuth,
  type ClaudeCliAuthInspection,
  type ClaudeCliProviderOptions,
  type ClaudeProcessFactory
} from "./cliProvider.ts";
import { claudeAuthenticationStatus, claudeProcessEnvironment } from "./auth.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import {
  assertClaudeSessionHistoryIdentity,
  claudeTranscriptContent,
  publicClaudeSessionDetail,
  publicClaudeSessionSummary,
  readBoundedClaudeSessionHistory
} from "./sessionHistory.ts";
import {
  type ExecutorCapability,
  type ExecutorProvider,
  type InterruptInput,
  type ProviderEvent,
  type ProviderRecoveryInput,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderRuntimeStatus,
  type SessionCreateInput,
  type SessionCreateResult,
  type SessionListInput,
  type SessionListResult,
  type SessionMessageInput,
  type SessionMessageResult,
  type SessionRef
} from "../types.ts";
import { ClaudePermissionBroker } from "./permissionBroker.ts";
import { cleanString } from "../../util/values.ts";

export type { ClaudeProcessFactory };

const PROVIDER = "claude" as const;
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const CLAUDE_AGENT_SDK_VERSION = "0.3.312";

type QueryInput = { prompt: string | AsyncIterable<unknown>; options?: ClaudeSdkOptions };
export type ClaudeQuery = AsyncIterable<unknown> & {
  close?: () => void;
  interrupt?: () => Promise<void>;
};
export type ClaudeQueryFactory = (input: QueryInput) => ClaudeQuery;

type ClaudeSessionFunctions = {
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  listSessions(options?: { dir?: string; limit?: number; offset?: number }): Promise<SDKSessionInfo[]>;
};

type ClaudeSdkProviderOptions = {
  authInspector?: (config: ProviderRuntimeConfig) => ClaudeCliAuthInspection;
  eventSink?: (event: ProviderEvent) => void;
  /** 常驻 Claude 进程空闲多久后释放；释放后下一条消息自动 resume。 */
  idleTimeoutMs?: number;
  queryFactory?: ClaudeQueryFactory;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<ClaudeSessionFunctions>;
  skipReadinessCheck?: boolean;
};

type ClaudeProviderOptions = ClaudeSdkProviderOptions & ClaudeCliProviderOptions;

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

export class ClaudeExecutorProvider implements ExecutorProvider {
  readonly id = PROVIDER;
  private readonly delegate: ExecutorProvider & { runtimeStatus?: () => ProviderRuntimeStatus };

  constructor(private readonly config: ProviderRuntimeConfig, options: ClaudeProviderOptions = {}) {
    const cliFallback = config.mode === "cli-fallback" || (config.mode === undefined && Boolean(options.processFactory) && !options.queryFactory);
    this.delegate = cliFallback
      ? new ClaudeCliExecutorProvider(config, {
        authInspector: options.authInspector,
        processFactory: options.processFactory,
        sessionIdFactory: options.sessionIdFactory,
        sessionFunctions: options.sessionFunctions
      })
      : new ClaudeSdkExecutorProvider(config, options);
  }

  get capabilities(): readonly ExecutorCapability[] { return this.delegate.capabilities; }
  get interruptScope(): ExecutorProvider["interruptScope"] { return this.delegate.interruptScope; }
  run(input: ProviderRunInput) { return this.delegate.run(input); }
  createSession(input: SessionCreateInput) { return requireMethod(this.delegate.createSession, "sessions").call(this.delegate, input); }
  recover(input: ProviderRecoveryInput) { return requireMethod(this.delegate.recover, "resume_session").call(this.delegate, input); }
  interrupt(input: InterruptInput) { return requireMethod(this.delegate.interrupt, "interrupt").call(this.delegate, input); }
  listSessions(input: SessionListInput) { return requireMethod(this.delegate.listSessions, "sessions").call(this.delegate, input); }
  readSession(sessionId: string, input?: SessionReadInput) { return requireMethod(this.delegate.readSession, "sessions").call(this.delegate, sessionId, input); }
  resolveApproval(requestId: string, decision: import("../types.ts").ApprovalDecision) {
    return requireMethod(this.delegate.resolveApproval, "approvals").call(this.delegate, requestId, decision);
  }
  sendSessionMessage(input: SessionMessageInput) { return requireMethod(this.delegate.sendSessionMessage, "resume_session").call(this.delegate, input); }
  stop() { return this.delegate.stop?.() ?? Promise.resolve(); }

  runtimeStatus(): ProviderRuntimeStatus {
    return this.delegate.runtimeStatus?.() ?? {
      ready: true,
      mode: "cli-fallback",
      version: "",
      active_sessions: 0,
      api_key_configured: cleanString(this.config.env.ANTHROPIC_API_KEY) !== ""
    };
  }
}

export function createClaudeExecutorProvider(
  config: ProviderRuntimeConfig,
  eventSink?: (event: ProviderEvent) => void
): ClaudeExecutorProvider {
  return new ClaudeExecutorProvider(config, { eventSink });
}

export function claudeProviderAppEvent(event: ProviderEvent): AppEvent {
  const rawPayload = claudeTranscriptContent(event.raw?.payload);
  return compactAppEvent({
    type: "claude.event",
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    method: event.raw?.method,
    raw_method: event.raw?.method,
    raw_payload: rawPayload,
    payload: rawPayload || claudeTranscriptContent(event.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error
  });
}

function sdkInput(
  input: Pick<SessionCreateInput, "approvalPolicy" | "cwd" | "model" | "reasoningEffort" | "sandbox"> & Pick<ProviderRunInput, "policy">,
  config: ProviderRuntimeConfig,
  resume = "",
  title = ""
): ClaudeSdkOptions {
  const tools = nativeStringArray(input, "tools") ?? claudeTools(input.sandbox);
  const model = cleanString(input.model) || cleanString(config.model);
  const effort = claudeEffort(input.reasoningEffort);
  const executable = resolveClaudeSdkExecutable();
  const hostToolGate = input.policy?.nativeSummary.hostToolGate === true;
  return {
    cwd: input.cwd,
    env: managedExecutionEnvironment({
      ...claudeProcessEnvironment(config),
      CLAUDE_AGENT_SDK_CLIENT_APP: "xuanwu/claude-provider"
    }),
    includePartialMessages: true,
    maxTurns: DEFAULT_MAX_TURNS,
    persistSession: true,
    permissionMode: nativePermissionMode(input) ?? claudePermissionMode(input.approvalPolicy),
    ...(nativeBoolean(input, "allowDangerouslySkipPermissions") ? { allowDangerouslySkipPermissions: true } : {}),
    tools,
    allowedTools: hostToolGate ? tools.filter((tool) => ["Read", "Grep", "Glob", "LS"].includes(tool)) : tools,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(effort ? { effort } : {}),
    ...(model && model !== "codex-default" ? { model } : {}),
    ...(resume ? { resume } : {}),
    // 只对新会话生效：续跑时 SDK 沿用会话里已保存的标题。
    ...(cleanString(title) ? { title: cleanString(title) } : {})
  };
}

function nativePermissionMode(input: Pick<ProviderRunInput, "policy">): ClaudeSdkOptions["permissionMode"] | undefined {
  const value = input.policy?.nativeSummary.permissionMode;
  return typeof value === "string" ? value as ClaudeSdkOptions["permissionMode"] : undefined;
}

function nativeStringArray(input: Pick<ProviderRunInput, "policy">, key: string): string[] | undefined {
  const value = input.policy?.nativeSummary[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function nativeBoolean(input: Pick<ProviderRunInput, "policy">, key: string): boolean {
  return input.policy?.nativeSummary[key] === true;
}

export function resolveClaudeSdkExecutable(): string {
  const configured = cleanString(Bun.env.XUANWU_CLAUDE_SDK_EXECUTABLE);
  if (configured) return isRegularFile(configured) ? configured : "";
  const bundled = bundledClaudeSdkExecutable();
  return compatibleSystemClaude(bundled) || bundled;
}

/**
 * 优先用用户终端里的 claude，让玄武与终端共用同一版本、配置与会话格式；
 * 只接受与 SDK 自带 CLI 同主次版本且不更旧的版本，否则回退到自带 CLI。
 * XUANWU_CLAUDE_SDK_USE_SYSTEM=0 可强制只用自带 CLI。
 */
function compatibleSystemClaude(bundled: string): string {
  if (cleanString(Bun.env.XUANWU_CLAUDE_SDK_USE_SYSTEM) === "0") return "";
  const candidate = [cleanString(Bun.which("claude") ?? ""), join(homedir(), ".local", "bin", "claude")]
    .find((path) => path !== "" && isRegularFile(path)) ?? "";
  if (candidate === "") return "";
  const system = claudeCliVersion(candidate);
  if (!system) return "";
  const required = bundled ? claudeCliVersion(bundled) : undefined;
  if (!required) return candidate;
  const compatible = system[0] === required[0] && system[1] === required[1] && system[2] >= required[2];
  return compatible ? candidate : "";
}

const cliVersionCache = new Map<string, [number, number, number] | undefined>();

function claudeCliVersion(path: string): [number, number, number] | undefined {
  let cacheKey = path;
  try {
    cacheKey = `${path}\0${statSync(path).mtimeMs}`;
  } catch {
    return undefined;
  }
  if (cliVersionCache.has(cacheKey)) return cliVersionCache.get(cacheKey);
  let version: [number, number, number] | undefined;
  try {
    const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.toString());
    if (result.exitCode === 0 && match) version = [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    version = undefined;
  }
  cliVersionCache.set(cacheKey, version);
  return version;
}

function bundledClaudeSdkExecutable(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const adjacent = `${process.execPath}.claude-agent-sdk${suffix}`;
  if (isRegularFile(adjacent)) return adjacent;
  const packageName = claudeSdkNativePackage();
  if (!packageName) return "";
  try {
    const resolved = Bun.resolveSync(`${packageName}/claude${suffix}`, import.meta.dir);
    return isRegularFile(resolved) ? resolved : "";
  } catch {
    return "";
  }
}

function claudeSdkNativePackage(): string {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "";
  if (!arch || !["darwin", "linux", "win32"].includes(process.platform)) return "";
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`;
}

function isRegularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compactAppEvent(event: AppEvent): AppEvent {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== "")) as AppEvent;
}

function claudeTools(sandbox: string | undefined): string[] {
  return cleanString(sandbox).toLowerCase() === "read-only"
    ? ["Read", "Grep", "Glob"]
    : ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
}

function claudePermissionMode(policy: string | undefined): "default" | "dontAsk" {
  return cleanString(policy).toLowerCase() === "always" ? "default" : "dontAsk";
}

function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const effort = cleanString(value);
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort as "low" | "medium" | "high" | "xhigh" | "max"
    : undefined;
}

function assertUsableCwd(cwd: string): void {
  const path = cleanString(cwd);
  if (path === "") throw new Error("Claude SDK issue run blocked: cwd is required");
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // Fall through to a stable error without exposing credentials.
  }
  throw new Error(`Claude SDK issue run blocked: cwd unavailable: ${path}`);
}

function registerClaudeAuthSecrets(env: Record<string, string>): void {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const value = cleanString(env[key]);
    if (value) registerSecretForRedaction(value);
  }
}

function sessionMessageResult(sessionId: string, turnId: string): SessionMessageResult {
  return { provider: PROVIDER, provider_session_id: sessionId, sessionId, turn_id: turnId };
}

/** 进程级参数一致的消息才能复用同一个常驻进程；env 含凭据，不进指纹。 */
function processKey(options: ClaudeSdkOptions, hostToolGate: boolean): string {
  return JSON.stringify([
    options.cwd,
    options.model ?? "",
    options.effort ?? "",
    options.permissionMode ?? "",
    options.allowDangerouslySkipPermissions === true,
    options.tools ?? [],
    options.allowedTools ?? [],
    options.maxTurns ?? 0,
    options.pathToClaudeCodeExecutable ?? "",
    hostToolGate
  ]);
}

function claudeResumeCommand(cwd: string, sessionId: string): string {
  const resume = `claude --resume ${shellQuote(sessionId)}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function numericCursor(value: string | undefined): number {
  const cursor = cleanString(value);
  if (cursor === "") return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Claude session cursor is invalid");
  return parsed;
}

function normalizeLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, 100) : 50;
}

function requireMethod<T extends (...args: never[]) => unknown>(method: T | undefined, capability: string): T {
  if (!method) throw new Error(`provider "claude" does not support capability "${capability}" in the selected mode`);
  return method;
}
