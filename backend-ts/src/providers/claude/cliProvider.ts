import { getSessionInfo as sdkGetSessionInfo, getSessionMessages as sdkGetSessionMessages, listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { splitCommand } from "../codex/jsonRpc.ts";
import { parseClaudeStreamJSONL } from "./stream.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { claudeProcessEnvironment, environmentAuthenticationStatus } from "./auth.ts";
import { assertClaudeSessionHistoryIdentity, publicClaudeSessionDetail, publicClaudeSessionSummary, readBoundedClaudeSessionHistory } from "./sessionHistory.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { ProviderInterruptedError, type ExecutorProvider, type InterruptInput, type ProviderRecoveryInput, type ProviderRunInput, type ProviderRunResult, type ProviderRuntimeStatus, type SessionCreateInput, type SessionCreateResult, type SessionListInput, type SessionListResult, type SessionMessageInput, type SessionMessageResult, type SessionRef, type SessionReadInput } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { PROVIDER, ActiveClaudeProcess, ClaudeCliProviderOptions, ClaudeCliExecutionInput, ClaudeProcess, ClaudeCliSessionFunctions, ClaudeProcessFactory } from "./cliProviderModel.ts";
import { requiredSession, numericCursor, normalizeLimit, inspectClaudeCliAuth, claudeCommand } from "./cliProviderOptions.ts";
import { waitForProcess, secretValues, interruptedCliEvent, emitStderr, commandError, terminateClaudeProcess } from "./cliProcessIO.ts";
import { assertUsableCwd, claudeCommandAvailable, spawnClaudeProcess } from "./cliProviderValues.ts";

export class ClaudeCliExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly id = PROVIDER;
  readonly interruptScope = "session" as const;
  private readonly active = new Map<string, ActiveClaudeProcess>();

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: ClaudeCliProviderOptions = {}) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    return await this.execute(input);
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    return await this.execute(input, input.session.sessionId);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const prompt = cleanString(input.prompt);
    if (prompt === "") throw new Error("Claude CLI session creation requires a prompt");
    const result = await this.execute({ ...input, prompt });
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
    const sessionId = cleanString(input.sessionId);
    if (sessionId === "") throw new Error("Claude CLI resume requires a session id");
    if (cleanString(input.mode) === "steer") throw new Error('provider "claude" does not support live steer; interrupt or resume the session instead');
    const discovered = cleanString(input.cwd) ? undefined : await this.sessionFunctions().getSessionInfo(sessionId);
    const cwd = cleanString(input.cwd) || cleanString(discovered?.cwd) || cleanString(this.config.cwd);
    const result = await this.execute({ ...input, cwd }, sessionId);
    const session = requiredSession(result);
    if (!session.turnId) throw new Error("Claude CLI completed without a provider turn ref");
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
      ...(cleanString(input.cwd) ? { dir: cleanString(input.cwd) } : {}),
      limit,
      offset
    });
    return {
      data: sessions.map((session) => publicClaudeSessionSummary(session, this.active.has(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string, input: SessionReadInput = {}): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = cleanString(sessionId);
    if (id === "") throw new Error("Claude CLI session id is required");
    const functions = this.sessionFunctions();
    const info = await functions.getSessionInfo(id);
    assertClaudeSessionHistoryIdentity(id, info, []);
    const messages = input.includeTurns === false ? [] : await readBoundedClaudeSessionHistory(
      id, info, functions.getSessionMessages.bind(functions)
    );
    if (!info && messages.length === 0) throw new Error(`Claude CLI session ${id} was not found`);
    assertClaudeSessionHistoryIdentity(id, info, messages);
    const running = this.active.has(id);
    return publicClaudeSessionDetail(id, info, messages, running);
  }

  private async execute(input: ClaudeCliExecutionInput, resume = ""): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    this.assertReady();
    const runId = input.issueId ? `cli:claude:${input.issueId}` : `cli:claude:${resume || "new-session"}`;
    const durableSessionID = resume || cleanString(this.options.sessionIdFactory?.()) || crypto.randomUUID();
    const process = this.spawn(input, resume, durableSessionID);
    const active: ActiveClaudeProcess = { interrupted: false, process, reason: "" };
    const session: SessionRef = { provider: PROVIDER, sessionId: durableSessionID };
    const aliases = new Set<string>();
    this.track(session, active, aliases);
    input.onEvent?.(providerSessionStartedEvent(PROVIDER, durableSessionID, {
      method: resume ? "claude-cli/session_resumed" : "claude-cli/session_started",
      metadata: { model: cleanString(input.model) || cleanString(this.config.model), sdk_transport: "cli" }
    }));
    try {
      const [stdout, stderr, exitCode] = await waitForProcess(process, this.config.timeoutMs);
      const secrets = secretValues(this.config.env);
      if (active.interrupted) {
        input.onEvent?.(interruptedCliEvent(session, active.reason));
        throw new ProviderInterruptedError(active.reason || "Claude CLI interrupted by host");
      }
      emitStderr(input, stderr, runId, secrets);
      const parsed = parseClaudeStreamJSONL(stdout, { runId, secrets, sessionId: durableSessionID });
      parsed.events.forEach((event) => {
        if (event.session?.sessionId && event.session.sessionId !== durableSessionID) {
          throw new Error(`Claude session ${durableSessionID} returned mismatched runtime ${event.session.sessionId}`);
        }
        if (event.session) this.track(event.session, active, aliases);
        input.onEvent?.(event);
      });
      if (exitCode !== 0) throw new Error(commandError(stderr, exitCode, secrets));
      if (!parsed.completed) throw new Error(redactSensitiveText(parsed.error || parsed.diagnostic || "Claude Code run did not complete"));
      return { runId, session: parsed.session };
    } finally {
      this.untrack(aliases);
    }
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const active = this.lookup(input.session);
    if (!active) return;
    active.interrupted = true;
    active.reason = input.reason || "runner interrupt";
    await terminateClaudeProcess(active.process, 500);
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const commandReady = Boolean(this.options.processFactory) || claudeCommandAvailable(this.config.command);
    const authMode = this.config.authMode ?? "local-cli";
    const environmentAuth = environmentAuthenticationStatus(this.config.env);
    const auth = authMode === "local-cli"
      ? this.options.processFactory
        ? { checked: false, logged_in: true }
        : (this.options.authInspector ?? inspectClaudeCliAuth)(this.config)
      : { checked: true, logged_in: environmentAuth.configured };
    const authConfigured = authMode === "local-cli"
      ? Boolean(this.options.processFactory) || (auth.checked && auth.logged_in)
      : environmentAuth.configured;
    // 本地 CLI 探测可能因启动超时或非 JSON 输出而暂时不可用。只有 Claude 明确返回
    // loggedIn=false 时才阻止执行；不确定状态交给真实 CLI 调用验证，避免一次探测故障
    // 永久把 Provider 固定为 not_ready。
    const localAuthUsable = Boolean(this.options.processFactory) || !auth.checked || auth.logged_in;
    const ready = commandReady && (authMode === "local-cli" ? localAuthUsable : environmentAuth.configured);
    return {
      active_sessions: new Set(this.active.values()).size,
      api_key_configured: authMode === "environment" && cleanString(this.config.env.ANTHROPIC_API_KEY) !== "",
      auth_configured: authConfigured,
      auth_mode: authMode,
      auth_source: authMode === "local-cli" ? "local_cli" : environmentAuth.source,
      mode: "cli-fallback",
      ready,
      ...(ready ? {} : { reason: commandReady
        ? authMode === "local-cli"
          ? "Claude CLI local login is unavailable; run `claude auth login` as the service user"
          : environmentAuth.reason || "Claude CLI environment authentication is unavailable"
        : `Claude CLI fallback command is unavailable: ${splitCommand(this.config.command)[0] || "claude"}` }),
      version: ""
    };
  }

  private spawn(input: ClaudeCliExecutionInput, resume: string, sessionID: string): ClaudeProcess {
    return this.processFactory()({
      command: claudeCommand(this.config, input, resume, sessionID),
      cwd: input.cwd,
      env: managedExecutionEnvironment(claudeProcessEnvironment(this.config))
    });
  }

  private assertReady(): void {
    const status = this.runtimeStatus();
    if (!status.ready) throw new Error(status.reason || "Claude CLI is not ready");
  }

  private sessionFunctions(): ClaudeCliSessionFunctions {
    return {
      getSessionInfo: this.options.sessionFunctions?.getSessionInfo ?? sdkGetSessionInfo,
      getSessionMessages: this.options.sessionFunctions?.getSessionMessages ?? sdkGetSessionMessages,
      listSessions: this.options.sessionFunctions?.listSessions ?? sdkListSessions
    };
  }

  private processFactory(): ClaudeProcessFactory {
    return this.options.processFactory ?? spawnClaudeProcess;
  }

  private track(session: SessionRef, active: ActiveClaudeProcess, aliases: Set<string>): void {
    for (const id of [session.sessionId, session.turnId]) {
      if (!id) continue;
      this.active.set(id, active);
      aliases.add(id);
    }
  }

  private untrack(aliases: Set<string>): void {
    aliases.forEach((id) => this.active.delete(id));
  }

  private lookup(session: SessionRef): ActiveClaudeProcess | undefined {
    return this.active.get(session.sessionId) ?? (session.turnId ? this.active.get(session.turnId) : undefined);
  }
}

export { type ClaudeProcessFactory, type ClaudeCliAuthInspection, type ClaudeCliProviderOptions } from "./cliProviderModel.ts";
export { inspectClaudeCliAuth } from "./cliProviderOptions.ts";
