import {
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  type SDKSessionInfo,
  type SessionMessage
} from "@anthropic-ai/claude-agent-sdk";
import { statSync } from "node:fs";
import { splitCommand } from "../codex/jsonRpc.ts";
import { parseClaudeStreamJSONL } from "./stream.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { claudeProcessEnvironment, environmentAuthenticationStatus } from "./auth.ts";
import {
  assertClaudeSessionHistoryIdentity,
  publicClaudeSessionDetail,
  publicClaudeSessionSummary
} from "./sessionHistory.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import {
  ProviderInterruptedError,
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

const PROVIDER = "claude";
const DEFAULT_MAX_TURNS = "50";
const STDERR_LIMIT = 4096;

export type ClaudeProcess = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): unknown;
};

export type ClaudeProcessFactory = (options: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => ClaudeProcess;

export type ClaudeCliAuthInspection = {
  auth_method?: string;
  checked: boolean;
  logged_in: boolean;
  provider?: string;
};

export type ClaudeCliProviderOptions = {
  authInspector?: (config: ProviderRuntimeConfig) => ClaudeCliAuthInspection;
  processFactory?: ClaudeProcessFactory;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<ClaudeCliSessionFunctions>;
};

type ActiveClaudeProcess = {
  interrupted: boolean;
  process: ClaudeProcess;
  reason: string;
};

type ClaudeCliSessionFunctions = {
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: { dir?: string; includeSystemMessages?: boolean }): Promise<SessionMessage[]>;
  listSessions(options?: { dir?: string; limit?: number; offset?: number }): Promise<SDKSessionInfo[]>;
};

type ClaudeCliExecutionInput = Pick<SessionCreateInput,
  "approvalPolicy" | "cwd" | "model" | "prompt" | "reasoningEffort" | "sandbox" | "serviceTier"
> & Pick<ProviderRunInput, "policy"> & {
  issueId?: number;
  onEvent?: (event: ProviderEvent) => void;
};

const cliAuthCache = new Map<string, { expiresAt: number; inspection: ClaudeCliAuthInspection }>();
const CLI_AUTH_CACHE_MS = 5_000;

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
    const prompt = clean(input.prompt);
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
    const sessionId = clean(input.sessionId);
    if (sessionId === "") throw new Error("Claude CLI resume requires a session id");
    if (clean(input.mode) === "steer") throw new Error('provider "claude" does not support live steer; interrupt or resume the session instead');
    const discovered = clean(input.cwd) ? undefined : await this.sessionFunctions().getSessionInfo(sessionId);
    const cwd = clean(input.cwd) || clean(discovered?.cwd) || clean(this.config.cwd);
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
      ...(clean(input.cwd) ? { dir: clean(input.cwd) } : {}),
      limit,
      offset
    });
    return {
      data: sessions.map((session) => publicClaudeSessionSummary(session, this.active.has(session.sessionId))),
      nextCursor: sessions.length === limit ? String(offset + sessions.length) : ""
    };
  }

  async readSession(sessionId: string): Promise<Record<string, unknown>> {
    this.assertReady();
    const id = clean(sessionId);
    if (id === "") throw new Error("Claude CLI session id is required");
    const [info, messages] = await Promise.all([
      this.sessionFunctions().getSessionInfo(id),
      this.sessionFunctions().getSessionMessages(id, { includeSystemMessages: false })
    ]);
    if (!info && messages.length === 0) throw new Error(`Claude CLI session ${id} was not found`);
    assertClaudeSessionHistoryIdentity(id, info, messages);
    const running = this.active.has(id);
    return publicClaudeSessionDetail(id, info, messages, running);
  }

  private async execute(input: ClaudeCliExecutionInput, resume = ""): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    this.assertReady();
    const runId = input.issueId ? `cli:claude:${input.issueId}` : `cli:claude:${resume || "new-session"}`;
    const durableSessionID = resume || clean(this.options.sessionIdFactory?.()) || crypto.randomUUID();
    const process = this.spawn(input, resume, durableSessionID);
    const active: ActiveClaudeProcess = { interrupted: false, process, reason: "" };
    const session: SessionRef = { provider: PROVIDER, sessionId: durableSessionID };
    const aliases = new Set<string>();
    this.track(session, active, aliases);
    input.onEvent?.(providerSessionStartedEvent(PROVIDER, durableSessionID, {
      method: resume ? "claude-cli/session_resumed" : "claude-cli/session_started",
      metadata: { model: clean(input.model) || clean(this.config.model), sdk_transport: "cli" }
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
      api_key_configured: authMode === "environment" && clean(this.config.env.ANTHROPIC_API_KEY) !== "",
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

export function createClaudeCliExecutorProvider(config: ProviderRuntimeConfig): ClaudeCliExecutorProvider {
  return new ClaudeCliExecutorProvider(config);
}

export function inspectClaudeCliAuth(config: ProviderRuntimeConfig): ClaudeCliAuthInspection {
  const executable = splitCommand(config.command)[0] ?? "";
  if (!claudeCommandAvailable(executable)) return { checked: false, logged_in: false };
  const environment = claudeProcessEnvironment(config);
  const cacheKey = [executable, environment.HOME ?? "", environment.CLAUDE_CONFIG_DIR ?? ""].join("\0");
  const cached = cliAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.inspection;
  let inspection: ClaudeCliAuthInspection = { checked: false, logged_in: false };
  try {
    const result = Bun.spawnSync([executable, "auth", "status", "--json"], {
      env: environment,
      maxBuffer: 64 * 1024,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 3_000
    });
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
    if (typeof parsed.loggedIn === "boolean") {
      inspection = {
        checked: true,
        logged_in: parsed.loggedIn,
        ...(safeAuthMethod(parsed.authMethod) ? { auth_method: safeAuthMethod(parsed.authMethod) } : {}),
        ...(safeLabel(parsed.apiProvider) ? { provider: safeLabel(parsed.apiProvider) } : {})
      };
    }
  } catch {
    // Authentication remains unavailable without exposing command output.
  }
  cliAuthCache.set(cacheKey, { expiresAt: Date.now() + CLI_AUTH_CACHE_MS, inspection });
  return inspection;
}

function claudeCommand(
  config: ProviderRuntimeConfig,
  input: Pick<SessionCreateInput, "approvalPolicy" | "model" | "prompt" | "sandbox"> & Pick<ProviderRunInput, "policy">,
  resume = "",
  sessionID = ""
): string[] {
  const command = splitCommand(config.command);
  const args = [
    "-p", "--verbose", "--output-format", "stream-json",
    "--permission-mode", claudeNativePermissionMode(input),
    "--allowedTools", claudeNativeAllowedTools(input)
  ];
  if (input.policy?.nativeSummary.allowDangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }
  if (resume) args.push("--resume", resume);
  else args.push("--session-id", sessionID);
  const model = clean(input.model) || clean(config.model);
  if (model !== "" && model !== "codex-default") args.push("--model", model);
  args.push("--max-turns", DEFAULT_MAX_TURNS, clean(input.prompt));
  return [...command, ...args];
}

function claudeNativePermissionMode(input: Pick<ProviderRunInput, "policy"> & { approvalPolicy?: string }): string {
  const native = input.policy?.nativeSummary.permissionMode;
  return typeof native === "string" && native.trim() !== "" ? native : claudePermissionMode(input.approvalPolicy);
}

function claudeNativeAllowedTools(input: Pick<ProviderRunInput, "policy"> & { sandbox?: string }): string {
  const native = input.policy?.nativeSummary.tools;
  return Array.isArray(native) && native.every((item) => typeof item === "string")
    ? native.join(",")
    : claudeAllowedTools(input.sandbox);
}

function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session?.sessionId) throw new Error("Claude CLI completed without a provider session id");
  return result.session;
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

function claudeAllowedTools(sandbox?: string): string {
  return clean(sandbox).toLowerCase() === "read-only"
    ? "Read,Grep,Glob,LS"
    : "Read,Grep,Glob,LS,Edit,MultiEdit,Write,Bash";
}

function claudePermissionMode(policy?: string): string {
  switch (clean(policy).toLowerCase()) {
    case "never":
    case "on-request":
    case "danger-only":
      return "dontAsk";
    default:
      return "default";
  }
}

function interruptedCliEvent(session: SessionRef, reason: string): ProviderEvent {
  const error = redactSensitiveText(reason || "Claude CLI interrupted by host");
  return {
    provider: PROVIDER,
    type: "error",
    status: "interrupted",
    error,
    session,
    raw: { method: "claude-cli/interrupted", payload: error },
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "claude-cli/interrupted",
      outcome: "interrupted",
      provider: PROVIDER,
      session
    })
  };
}

async function waitForProcess(process: ClaudeProcess, timeoutMs: number): Promise<[string, string, number]> {
  const output = Promise.all([readStream(process.stdout), readStream(process.stderr), process.exited]) as Promise<[string, string, number]>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("claude-timeout");
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), Math.max(1, timeoutMs));
  });
  try {
    const result = await Promise.race([output, timeout]);
    if (result !== timedOut) return result;
    await terminateClaudeProcess(process, 500);
    throw new Error(`Claude Code run timed out after ${timeoutMs}ms`);
  } finally {
    if (timer) clearTimeout(timer);
    output.catch(() => undefined);
  }
}

async function terminateClaudeProcess(process: ClaudeProcess, graceMs: number): Promise<void> {
  process.kill("SIGTERM");
  if (await exitsWithin(process, graceMs)) return;
  process.kill("SIGKILL");
  await exitsWithin(process, graceMs);
}

async function exitsWithin(process: ClaudeProcess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs)); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function emitStderr(input: ClaudeCliExecutionInput, stderr: string, runId: string, secrets: string[]): void {
  for (const line of stderr.split(/\r?\n/)) {
    const text = redact(line, secrets).trim();
    if (text === "") continue;
    input.onEvent?.({
      provider: PROVIDER,
      type: "stderr",
      text,
      session: { provider: PROVIDER, sessionId: runId, turnId: runId },
      raw: { method: "stderr", payload: text },
      runEvent: normalizedRunEvent({
        kind: "progress",
        method: "stderr",
        outcome: "running",
        provider: PROVIDER,
        session: { provider: PROVIDER, sessionId: runId, turnId: runId }
      })
    });
  }
}

function commandError(stderr: string, exitCode: number, secrets: string[]): string {
  const captured = stderr.trim().slice(0, STDERR_LIMIT);
  const message = captured || `exit code ${exitCode}`;
  return `Claude Code run failed: ${redact(message, secrets)}`;
}

function secretValues(env: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const key of [
    "XUANWU_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN"
  ]) {
    const value = clean(env[key]) || clean(Bun.env[key]);
    if (value !== "") values.add(value);
  }
  return [...values];
}

function redact(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
  return redactSensitiveText(out);
}

function assertUsableCwd(cwd: string): void {
  const path = clean(cwd);
  if (path === "") throw new Error("Claude Code issue run blocked: cwd is required");
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // fall through to stable sanitized error below
  }
  throw new Error(`Claude Code issue run blocked: cwd unavailable: ${path}`);
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function safeLabel(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_. -]{1,64}$/.test(text) ? text : "";
}

function safeAuthMethod(value: unknown): string {
  const method = safeLabel(value);
  return method === "oauth_token" ? "oauth" : method;
}

function spawnClaudeProcess({ command, cwd, env }: Parameters<ClaudeProcessFactory>[0]): ClaudeProcess {
  return Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

function claudeCommandAvailable(command: string): boolean {
  const executable = splitCommand(command)[0] ?? "";
  if (executable === "") return false;
  if (!executable.includes("/")) return Boolean(Bun.which(executable));
  try {
    const stat = statSync(executable);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
