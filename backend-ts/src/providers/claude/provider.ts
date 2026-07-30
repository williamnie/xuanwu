import {
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query as sdkQuery,
  type Options as ClaudeSdkOptions,
  type Query as ClaudeSdkQuery,
  type SDKSessionInfo,
  type SessionMessage
} from "@anthropic-ai/claude-agent-sdk";
import { accessSync, constants, statSync } from "node:fs";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { redactRegisteredSecrets, registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { AppEvent } from "../../events/bus.ts";
import {
  createClaudeSdkStreamState,
  interruptedClaudeSdkEvent,
  projectClaudeSdkMessage,
  timedOutClaudeSdkEvent,
  type ClaudeSdkStreamState
} from "./sdkStream.ts";
import {
  ClaudeCliExecutorProvider,
  type ClaudeCliProviderOptions,
  type ClaudeProcess,
  type ClaudeProcessFactory
} from "./cliProvider.ts";
import { claudeAuthenticationStatus, claudeProcessEnvironment } from "./auth.ts";
import type {
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderEvent,
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

export type { ClaudeProcess, ClaudeProcessFactory };

const PROVIDER = "claude" as const;
const DEFAULT_MAX_TURNS = 50;
export const CLAUDE_AGENT_SDK_VERSION = "0.3.152";

type QueryInput = { prompt: string | AsyncIterable<unknown>; options?: ClaudeSdkOptions };
export type ClaudeQuery = AsyncIterable<unknown> & {
  close?: () => void;
  interrupt?: () => Promise<void>;
};
export type ClaudeQueryFactory = (input: QueryInput) => ClaudeQuery;

export type ClaudeSessionFunctions = {
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: { dir?: string; includeSystemMessages?: boolean }): Promise<SessionMessage[]>;
  listSessions(options?: { dir?: string; limit?: number; offset?: number }): Promise<SDKSessionInfo[]>;
};

export type ClaudeSdkProviderOptions = {
  eventSink?: (event: ProviderEvent) => void;
  queryFactory?: ClaudeQueryFactory;
  sessionFunctions?: Partial<ClaudeSessionFunctions>;
  skipReadinessCheck?: boolean;
};

export type ClaudeProviderOptions = ClaudeSdkProviderOptions & ClaudeCliProviderOptions;

type ActiveQuery = {
  aliases: Set<string>;
  controller: AbortController;
  query?: ClaudeQuery;
  state: ClaudeSdkStreamState;
  timedOut: boolean;
};

export class ClaudeSdkExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly id = PROVIDER;
  private readonly active = new Map<string, ActiveQuery>();

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: ClaudeSdkProviderOptions = {}) {
    registerClaudeAuthSecrets(config.env);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    return await this.execute(input.prompt, sdkInput(input, this.config), input.onEvent);
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    return await this.execute(input.prompt, sdkInput(input, this.config, input.session.sessionId), input.onEvent, input.session.sessionId);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    assertUsableCwd(input.cwd);
    const prompt = clean(input.prompt);
    if (prompt === "") throw new Error("Claude SDK session creation requires a prompt");
    const result = await this.execute(prompt, sdkInput(input, this.config), undefined);
    const session = requiredSession(result);
    return {
      id: `${PROVIDER}:${session.sessionId}`,
      provider: PROVIDER,
      provider_session_id: session.sessionId,
      provider_turn_id: session.turnId,
      thread_id: session.sessionId,
      turn_id: session.turnId
    };
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    const sessionId = clean(input.sessionId);
    if (sessionId === "") throw new Error("Claude SDK resume requires a session id");
    if (clean(input.mode) === "steer") throw new Error('provider "claude" does not support live steer; interrupt or resume the session instead');
    const discovered = clean(input.cwd) ? undefined : await this.sessionFunctions().getSessionInfo(sessionId);
    const cwd = clean(input.cwd) || clean(discovered?.cwd) || clean(this.config.cwd);
    assertUsableCwd(cwd);
    const prompt = clean(input.prompt);
    if (prompt === "") throw new Error("Claude SDK session message requires a prompt");
    const result = await this.execute(prompt, sdkInput({ ...input, cwd }, this.config, sessionId), undefined, sessionId);
    const session = requiredSession(result);
    if (!session.turnId) throw new Error("Claude SDK completed without a provider turn ref");
    return {
      provider: PROVIDER,
      provider_session_id: session.sessionId,
      sessionId: session.sessionId,
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
    return {
      data: sessions.map((session) => publicSessionSummary(session, this.active.has(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = clean(sessionId);
    if (id === "") throw new Error("Claude SDK session id is required");
    const [info, messages] = await Promise.all([
      this.sessionFunctions().getSessionInfo(id),
      this.sessionFunctions().getSessionMessages(id, { includeSystemMessages: false })
    ]);
    if (!info && messages.length === 0) throw new Error(`Claude SDK session ${id} was not found`);
    const running = this.active.has(id);
    return {
      id: `${PROVIDER}:${id}`,
      provider: PROVIDER,
      provider_session_id: id,
      sessionId: id,
      thread_id: id,
      name: redactSensitiveText(info?.customTitle || info?.summary || "Claude session"),
      preview: redactSensitiveText(info?.firstPrompt || info?.summary || ""),
      cwd: info?.cwd || "",
      status: running ? "running" : "idle",
      isRunning: running,
      createdAt: info ? Math.floor(info.lastModified / 1000) : 0,
      updatedAt: info ? Math.floor(info.lastModified / 1000) : 0,
      turns: transcriptTurns(messages)
    };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const active = this.lookup(input.session);
    if (!active) throw new Error(`Claude SDK session ${input.session.sessionId} is not active`);
    try {
      await active.query?.interrupt?.();
    } finally {
      active.controller.abort(input.reason || "runner interrupt");
      active.query?.close?.();
    }
  }

  async stop(): Promise<void> {
    const active = [...new Set(this.active.values())];
    for (const item of active) {
      item.controller.abort("runner shutdown");
      item.query?.close?.();
      this.untrack(item);
    }
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const authentication = claudeAuthenticationStatus(this.config);
    const executableReady = resolveClaudeSdkExecutable() !== "";
    const injectedRuntime = this.options.skipReadinessCheck === true || Boolean(this.options.queryFactory);
    const ready = injectedRuntime || (authentication.configured && executableReady);
    return {
      ready,
      mode: "sdk",
      version: CLAUDE_AGENT_SDK_VERSION,
      active_sessions: new Set(this.active.values()).size,
      api_key_configured: this.config.authMode === "environment" && clean(this.config.env.ANTHROPIC_API_KEY) !== "",
      auth_configured: authentication.configured,
      auth_mode: authentication.mode,
      auth_source: authentication.source,
      executable_ready: executableReady,
      ...(authentication.platform_profile ? { platform_profile: authentication.platform_profile } : {}),
      ...(ready ? {} : {
        reason: authentication.configured
          ? "Claude SDK native executable is unavailable"
          : authentication.reason || "Claude SDK authentication is not configured"
      })
    };
  }

  private async execute(
    prompt: string,
    options: ClaudeSdkOptions,
    onEvent?: (event: ProviderEvent) => void,
    resumeAlias = ""
  ): Promise<ProviderRunResult> {
    this.assertReady();
    const active: ActiveQuery = {
      aliases: new Set(),
      controller: options.abortController ?? new AbortController(),
      state: createClaudeSdkStreamState(),
      timedOut: false
    };
    options.abortController = active.controller;
    if (resumeAlias) this.trackAlias(active, resumeAlias);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const query = this.queryFactory()({ prompt, options });
      active.query = query;
      timer = setTimeout(() => {
        active.timedOut = true;
        const reason = `Claude SDK query timed out after ${this.config.timeoutMs}ms`;
        void query.interrupt?.().catch(() => undefined);
        active.controller.abort(reason);
        query.close?.();
      }, Math.max(1, this.config.timeoutMs));
      for await (const message of query) {
        const events = projectClaudeSdkMessage(message, active.state);
        if (active.state.sessionId) this.trackAlias(active, active.state.sessionId);
        if (active.state.turnId) this.trackAlias(active, active.state.turnId);
        for (const event of events) this.emit(event, onEvent);
      }
      if (active.controller.signal.aborted && !active.state.terminal) {
        this.emit(abortEvent(active), onEvent);
      }
      if (active.timedOut) throw new Error(abortReason(active.controller));
      if (!active.state.terminal) throw new Error("Claude SDK query ended without a terminal result event");
      if (!active.state.completed && !active.state.interrupted) throw new Error("Claude SDK query failed");
      const session = sessionRef(active.state);
      return {
        runId: `sdk:claude:${session?.sessionId || "unknown"}:${session?.turnId || "unknown"}`,
        session
      };
    } catch (error) {
      if (active.controller.signal.aborted) {
        if (!active.state.terminal) this.emit(abortEvent(active), onEvent);
        if (active.timedOut) throw new Error(abortReason(active.controller));
        return {
          runId: `sdk:claude:${active.state.sessionId || "interrupted"}:${active.state.turnId || "interrupted"}`,
          session: sessionRef(active.state)
        };
      }
      throw new Error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    } finally {
      if (timer) clearTimeout(timer);
      active.query?.close?.();
      this.untrack(active);
    }
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

  private trackAlias(active: ActiveQuery, alias: string): void {
    const id = clean(alias);
    if (id === "" || active.aliases.has(id)) return;
    const existing = this.active.get(id);
    if (existing && existing !== active) throw new Error(`Claude SDK session ${id} already has an active query`);
    this.active.set(id, active);
    active.aliases.add(id);
  }

  private untrack(active: ActiveQuery): void {
    for (const alias of active.aliases) {
      if (this.active.get(alias) === active) this.active.delete(alias);
    }
    active.aliases.clear();
  }

  private lookup(session: SessionRef): ActiveQuery | undefined {
    return this.active.get(session.sessionId) ?? (session.turnId ? this.active.get(session.turnId) : undefined);
  }
}

export class ClaudeExecutorProvider implements ExecutorProvider {
  readonly id = PROVIDER;
  private readonly delegate: ExecutorProvider & { runtimeStatus?: () => ProviderRuntimeStatus };

  constructor(private readonly config: ProviderRuntimeConfig, options: ClaudeProviderOptions = {}) {
    const cliFallback = config.mode === "cli-fallback" || (config.mode === undefined && Boolean(options.processFactory) && !options.queryFactory);
    this.delegate = cliFallback
      ? new ClaudeCliExecutorProvider(config, { processFactory: options.processFactory })
      : new ClaudeSdkExecutorProvider(config, options);
  }

  get capabilities(): readonly ExecutorCapability[] { return this.delegate.capabilities; }
  run(input: ProviderRunInput) { return this.delegate.run(input); }
  createSession(input: SessionCreateInput) { return requireMethod(this.delegate.createSession, "sessions").call(this.delegate, input); }
  recover(input: ProviderRecoveryInput) { return requireMethod(this.delegate.recover, "resume_session").call(this.delegate, input); }
  interrupt(input: InterruptInput) { return requireMethod(this.delegate.interrupt, "interrupt").call(this.delegate, input); }
  listSessions(input: SessionListInput) { return requireMethod(this.delegate.listSessions, "sessions").call(this.delegate, input); }
  readSession(sessionId: string) { return requireMethod(this.delegate.readSession, "sessions").call(this.delegate, sessionId); }
  sendSessionMessage(input: SessionMessageInput) { return requireMethod(this.delegate.sendSessionMessage, "resume_session").call(this.delegate, input); }
  stop() { return this.delegate.stop?.() ?? Promise.resolve(); }

  runtimeStatus(): ProviderRuntimeStatus {
    return this.delegate.runtimeStatus?.() ?? {
      ready: true,
      mode: "cli-fallback",
      version: "",
      active_sessions: 0,
      api_key_configured: clean(this.config.env.ANTHROPIC_API_KEY) !== ""
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
  const rawPayload = transcriptContent(event.raw?.payload);
  return compactAppEvent({
    type: "claude.event",
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    method: event.raw?.method,
    raw_method: event.raw?.method,
    raw_payload: rawPayload,
    payload: rawPayload || transcriptContent(event.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error
  });
}

function sdkInput(
  input: Pick<SessionCreateInput, "approvalPolicy" | "cwd" | "model" | "reasoningEffort" | "sandbox">,
  config: ProviderRuntimeConfig,
  resume = ""
): ClaudeSdkOptions {
  const tools = claudeTools(input.sandbox);
  const model = clean(input.model) || clean(config.model);
  const effort = claudeEffort(input.reasoningEffort);
  const executable = resolveClaudeSdkExecutable();
  return {
    cwd: input.cwd,
    env: managedExecutionEnvironment({
      ...claudeProcessEnvironment(config),
      CLAUDE_AGENT_SDK_CLIENT_APP: "codex-issue-runner/claude-provider"
    }),
    includePartialMessages: true,
    maxTurns: DEFAULT_MAX_TURNS,
    persistSession: true,
    permissionMode: claudePermissionMode(input.approvalPolicy),
    tools,
    allowedTools: tools,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(effort ? { effort } : {}),
    ...(model && model !== "codex-default" ? { model } : {}),
    ...(resume ? { resume } : {})
  };
}

export function resolveClaudeSdkExecutable(): string {
  const configured = clean(Bun.env.CODEX_RUNNER_CLAUDE_SDK_EXECUTABLE);
  if (configured) return isRegularFile(configured) ? configured : "";
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

function publicSessionSummary(info: SDKSessionInfo, running = false): Record<string, unknown> {
  return {
    id: `${PROVIDER}:${info.sessionId}`,
    provider: PROVIDER,
    provider_session_id: info.sessionId,
    sessionId: info.sessionId,
    thread_id: info.sessionId,
    name: redactSensitiveText(info.customTitle || info.summary || "Claude session"),
    preview: redactSensitiveText(info.firstPrompt || info.summary || ""),
    cwd: info.cwd || "",
    status: running ? "running" : "idle",
    isRunning: running,
    createdAt: Math.floor(info.lastModified / 1000),
    updatedAt: Math.floor(info.lastModified / 1000)
  };
}

function transcriptTurns(messages: SessionMessage[]): Array<Record<string, unknown>> {
  const turns: Array<{ id: string; items: Array<Record<string, unknown>> }> = [];
  for (const entry of messages) {
    const items = transcriptItems(entry);
    if (items.length === 0) continue;
    const startsUserTurn = entry.type === "user" && items.some((item) => item.type === "userMessage");
    if (startsUserTurn || turns.length === 0) turns.push({ id: entry.uuid || `turn-${turns.length + 1}`, items: [] });
    turns.at(-1)!.items.push(...items);
  }
  return turns;
}

function transcriptItems(entry: SessionMessage): Array<Record<string, unknown>> {
  if (entry.type === "system") return [];
  const message = objectValue(entry.message);
  const content = Array.isArray(message.content) ? message.content : message.content ? [message.content] : [];
  if (typeof message.content === "string") {
    const text = redactSensitiveText(message.content);
    return text ? [{ id: entry.uuid, type: entry.type === "assistant" ? "agentMessage" : "userMessage", text }] : [];
  }
  return content.flatMap((value, index) => {
    const block = objectValue(value);
    const id = stringValue(block.id) || `${entry.uuid}:${index}`;
    if (block.type === "text") {
      const text = redactSensitiveText(stringValue(block.text));
      return text ? [{ id, type: entry.type === "assistant" ? "agentMessage" : "userMessage", text }] : [];
    }
    if (block.type === "tool_use") return [transcriptToolUse(id, block)];
    if (block.type === "tool_result") {
      return [{ id, type: "custom_tool_call_output", output: transcriptContent(block.content), status: block.is_error ? "failed" : "completed" }];
    }
    return [];
  });
}

function transcriptToolUse(id: string, block: Record<string, unknown>): Record<string, unknown> {
  const name = stringValue(block.name) || "tool";
  const input = objectValue(block.input);
  if (name === "Bash") {
    return { id, type: "commandExecution", command: redactSensitiveText(stringValue(input.command)), text: "", status: "completed" };
  }
  if (name === "Edit" || name === "Write") {
    return {
      id,
      type: "fileChange",
      path: redactSensitiveText(stringValue(input.file_path)),
      text: transcriptContent(input),
      status: "completed"
    };
  }
  return { id, type: "custom_tool_call", name, input: redactRegisteredSecrets(input) };
}

function transcriptContent(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return redactSensitiveText(value);
  try { return redactSensitiveText(JSON.stringify(value, null, 2)); } catch { return redactSensitiveText(String(value)); }
}

function compactAppEvent(event: AppEvent): AppEvent {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== "")) as AppEvent;
}

function claudeTools(sandbox: string | undefined): string[] {
  return clean(sandbox).toLowerCase() === "read-only"
    ? ["Read", "Grep", "Glob"]
    : ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
}

function claudePermissionMode(policy: string | undefined): "default" | "dontAsk" {
  return clean(policy).toLowerCase() === "always" ? "default" : "dontAsk";
}

function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const effort = clean(value);
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort as "low" | "medium" | "high" | "xhigh" | "max"
    : undefined;
}

function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session?.sessionId) throw new Error("Claude SDK completed without a provider session id");
  return result.session;
}

function sessionRef(state: ClaudeSdkStreamState): SessionRef | undefined {
  if (!state.sessionId) return undefined;
  return { provider: PROVIDER, sessionId: state.sessionId, ...(state.turnId ? { turnId: state.turnId } : {}) };
}

function assertUsableCwd(cwd: string): void {
  const path = clean(cwd);
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
    const value = clean(env[key]);
    if (value) registerSecretForRedaction(value);
  }
}

function abortReason(controller: AbortController): string {
  const reason = controller.signal.reason;
  return redactSensitiveText(reason instanceof Error ? reason.message : String(reason || "Claude SDK query interrupted"));
}

function abortEvent(active: ActiveQuery): ProviderEvent {
  const reason = abortReason(active.controller);
  return active.timedOut
    ? timedOutClaudeSdkEvent(active.state, reason)
    : interruptedClaudeSdkEvent(active.state, reason);
}

function numericCursor(value: string | undefined): number {
  const cursor = clean(value);
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
