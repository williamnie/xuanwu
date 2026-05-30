import { statSync } from "node:fs";
import { splitCommand } from "../codex/jsonRpc.ts";
import { parseClaudeStreamJSONL } from "./stream.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput, ProviderRunResult } from "../types.ts";

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

export type ClaudeProviderOptions = { processFactory?: ClaudeProcessFactory };

export class ClaudeExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = PROVIDER;

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: ClaudeProviderOptions = {}) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertUsableCwd(input.cwd);
    const runId = `cli:claude:${input.issueId}`;
    const process = this.spawn(input);
    const [stdout, stderr, exitCode] = await waitForProcess(process, this.config.timeoutMs);
    const secrets = secretValues(this.config.env);
    emitStderr(input, stderr, runId, secrets);
    const parsed = parseClaudeStreamJSONL(stdout, { runId, secrets });
    parsed.events.forEach((event) => input.onEvent?.(event));
    if (exitCode !== 0) throw new Error(commandError(stderr, exitCode, secrets));
    if (!parsed.completed) throw new Error(redactSensitiveText(parsed.error || parsed.diagnostic || "Claude Code run did not complete"));
    return { runId, session: parsed.session };
  }

  private spawn(input: ProviderRunInput): ClaudeProcess {
    return this.processFactory()({
      command: claudeCommand(this.config, input),
      cwd: input.cwd,
      env: { ...Bun.env, ...this.config.env }
    });
  }

  private processFactory(): ClaudeProcessFactory {
    return this.options.processFactory ?? spawnClaudeProcess;
  }
}

export function createClaudeExecutorProvider(config: ProviderRuntimeConfig): ClaudeExecutorProvider {
  return new ClaudeExecutorProvider(config);
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
    ? "Read,Grep,Glob,LS,Bash(codex-issue-runner issue update:*),Bash(curl:*)"
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
      raw: { method: "stderr", payload: text }
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
  for (const key of ["CODEX_RUNNER_AUTH_TOKEN", "CODEX_RUNNER_BUN_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
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

function spawnClaudeProcess({ command, cwd, env }: Parameters<ClaudeProcessFactory>[0]): ClaudeProcess {
  return Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}
