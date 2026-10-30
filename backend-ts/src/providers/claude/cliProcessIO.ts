import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { type ProviderEvent, type SessionRef } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { PROVIDER, ClaudeProcess, ClaudeCliExecutionInput, STDERR_LIMIT } from "./cliProviderModel.ts";

export function interruptedCliEvent(session: SessionRef, reason: string): ProviderEvent {
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

export async function waitForProcess(process: ClaudeProcess, timeoutMs: number): Promise<[string, string, number]> {
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

export async function terminateClaudeProcess(process: ClaudeProcess, graceMs: number): Promise<void> {
  process.kill("SIGTERM");
  if (await exitsWithin(process, graceMs)) return;
  process.kill("SIGKILL");
  await exitsWithin(process, graceMs);
}

export async function exitsWithin(process: ClaudeProcess, timeoutMs: number): Promise<boolean> {
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

export async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
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

export function emitStderr(input: ClaudeCliExecutionInput, stderr: string, runId: string, secrets: string[]): void {
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

export function commandError(stderr: string, exitCode: number, secrets: string[]): string {
  const captured = stderr.trim().slice(0, STDERR_LIMIT);
  const message = captured || `exit code ${exitCode}`;
  return `Claude Code run failed: ${redact(message, secrets)}`;
}

export function secretValues(env: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const key of [
    "XUANWU_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN"
  ]) {
    const value = cleanString(env[key]) || cleanString(Bun.env[key]);
    if (value !== "") values.add(value);
  }
  return [...values];
}

export function redact(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
  return redactSensitiveText(out);
}
