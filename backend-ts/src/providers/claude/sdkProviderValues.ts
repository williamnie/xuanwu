import { type Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { statSync } from "node:fs";
import { registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import type { AppEvent } from "../../events/bus.ts";
import { type SessionMessageResult } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { PROVIDER } from "./sdkProviderModel.ts";

export function compactAppEvent(event: AppEvent): AppEvent {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== "")) as AppEvent;
}

export function claudeTools(sandbox: string | undefined): string[] {
  return cleanString(sandbox).toLowerCase() === "read-only"
    ? ["Read", "Grep", "Glob"]
    : ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
}

export function claudePermissionMode(policy: string | undefined): "default" | "dontAsk" {
  return cleanString(policy).toLowerCase() === "always" ? "default" : "dontAsk";
}

export function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const effort = cleanString(value);
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort as "low" | "medium" | "high" | "xhigh" | "max"
    : undefined;
}

export function assertUsableCwd(cwd: string): void {
  const path = cleanString(cwd);
  if (path === "") throw new Error("Claude SDK issue run blocked: cwd is required");
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // Fall through to a stable error without exposing credentials.
  }
  throw new Error(`Claude SDK issue run blocked: cwd unavailable: ${path}`);
}

export function registerClaudeAuthSecrets(env: Record<string, string>): void {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const value = cleanString(env[key]);
    if (value) registerSecretForRedaction(value);
  }
}

export function sessionMessageResult(sessionId: string, turnId: string): SessionMessageResult {
  return { provider: PROVIDER, provider_session_id: sessionId, sessionId, turn_id: turnId };
}

/** 进程级参数一致的消息才能复用同一个常驻进程；env 含凭据，不进指纹。 */
export function processKey(options: ClaudeSdkOptions, hostToolGate: boolean): string {
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

export function claudeResumeCommand(cwd: string, sessionId: string): string {
  const resume = `claude --resume ${shellQuote(sessionId)}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function numericCursor(value: string | undefined): number {
  const cursor = cleanString(value);
  if (cursor === "") return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Claude session cursor is invalid");
  return parsed;
}

export function normalizeLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, 100) : 50;
}

export function requireMethod<T extends (...args: never[]) => unknown>(method: T | undefined, capability: string): T {
  if (!method) throw new Error(`provider "claude" does not support capability "${capability}" in the selected mode`);
  return method;
}
