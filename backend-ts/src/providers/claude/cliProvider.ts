import { statSync } from "node:fs";
import { splitCommand } from "../codex/jsonRpc.ts";
import { parseClaudeStreamJSONL } from "./stream.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { claudeProcessEnvironment, environmentAuthenticationStatus } from "./auth.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ExecutorProvider, InterruptInput, ProviderEvent, ProviderRunInput, ProviderRunResult, ProviderRuntimeStatus, SessionRef } from "../types.ts";

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
};

const cliAuthCache = new Map<string, { expiresAt: number; inspection: ClaudeCliAuthInspection }>();
const CLI_AUTH_CACHE_MS = 5_000;

export class ClaudeCliExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "interrupt"] as const;
  readonly id = PROVIDER;
  private readonly active = new Map<string, ClaudeProcess>();

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: ClaudeCliProviderOptions = {}) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    const runId = `cli:claude:${input.issueId}`;
    const process = this.spawn(input);
    const session = runSession(runId);
    const aliases = new Set<string>();
    this.track(session, process, aliases);
    input.onEvent?.(startEvent(session, input, this.config));
    try {
      const [stdout, stderr, exitCode] = await waitForProcess(process, this.config.timeoutMs);
      const secrets = secretValues(this.config.env);
      emitStderr(input, stderr, runId, secrets);
      const parsed = parseClaudeStreamJSONL(stdout, { runId, secrets });
      parsed.events.forEach((event) => {
        if (event.session) this.track(event.session, process, aliases);
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
    const process = this.lookup(input.session);
    if (!process) return;
    process.kill("SIGTERM");
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
    const authConfigured = authMode === "local-cli" ? auth.logged_in : environmentAuth.configured;
    const ready = commandReady && (Boolean(this.options.processFactory) || authConfigured);
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

  private spawn(input: ProviderRunInput): ClaudeProcess {
    return this.processFactory()({
      command: claudeCommand(this.config, input),
      cwd: input.cwd,
      env: managedExecutionEnvironment(claudeProcessEnvironment(this.config))
    });
  }

  private processFactory(): ClaudeProcessFactory {
    return this.options.processFactory ?? spawnClaudeProcess;
  }

  private track(session: SessionRef, process: ClaudeProcess, aliases: Set<string>): void {
    for (const id of [session.sessionId, session.turnId]) {
      if (!id) continue;
      this.active.set(id, process);
      aliases.add(id);
    }
  }

  private untrack(aliases: Set<string>): void {
    aliases.forEach((id) => this.active.delete(id));
  }

  private lookup(session: SessionRef): ClaudeProcess | undefined {
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
    inspection = {
      checked: result.exitCode === 0,
      logged_in: result.exitCode === 0 && parsed.loggedIn === true,
      ...(safeLabel(parsed.authMethod) ? { auth_method: safeLabel(parsed.authMethod) } : {}),
      ...(safeLabel(parsed.apiProvider) ? { provider: safeLabel(parsed.apiProvider) } : {})
    };
  } catch {
    // Authentication remains unavailable without exposing command output.
  }
  cliAuthCache.set(cacheKey, { expiresAt: Date.now() + CLI_AUTH_CACHE_MS, inspection });
  return inspection;
}

function claudeCommand(config: ProviderRuntimeConfig, input: ProviderRunInput): string[] {
  const command = splitCommand(config.command);
  const args = [
    "-p", "--verbose", "--bare", "--output-format", "stream-json",
    "--permission-mode", claudePermissionMode(input.approvalPolicy),
    "--allowedTools", claudeAllowedTools(input.sandbox)
  ];
  const model = clean(input.model) || clean(config.model);
  if (model !== "" && model !== "codex-default") args.push("--model", model);
  args.push("--max-turns", DEFAULT_MAX_TURNS, input.prompt);
  return [...command, ...args];
}

function claudeAllowedTools(sandbox?: string): string {
  return clean(sandbox).toLowerCase() === "read-only"
    ? "Read,Grep,Glob,LS,Bash(xuanwu issue update:*),Bash(curl:*)"
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

function runSession(runId: string): SessionRef {
  return { provider: PROVIDER, sessionId: runId, turnId: runId };
}

function startEvent(session: SessionRef, input: ProviderRunInput, config: ProviderRuntimeConfig): ProviderEvent {
  return {
    provider: PROVIDER,
    type: "text",
    status: "started",
    session,
    raw: { method: "start", payload: "Claude Code child process started" },
    runEvent: normalizedRunEvent({
      kind: "started",
      metadata: { model: clean(input.model) || clean(config.model) },
      method: "start",
      outcome: "running",
      provider: PROVIDER,
      session
    })
  };
}

async function waitForProcess(process: ClaudeProcess, timeoutMs: number): Promise<[string, string, number]> {
  const output = Promise.all([readStream(process.stdout), readStream(process.stderr), process.exited]) as Promise<[string, string, number]>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      process.kill("SIGTERM");
      reject(new Error(`Claude Code run timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([output, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    output.catch(() => undefined);
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

function emitStderr(input: ProviderRunInput, stderr: string, runId: string, secrets: string[]): void {
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
