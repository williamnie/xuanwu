import { splitCommand } from "../codex/jsonRpc.ts";
import { claudeProcessEnvironment } from "./auth.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { type ProviderRunInput, type ProviderRunResult, type SessionCreateInput, type SessionRef } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { ClaudeCliAuthInspection, cliAuthCache, CLI_AUTH_CACHE_MS, DEFAULT_MAX_TURNS } from "./cliProviderModel.ts";
import { claudeCommandAvailable, safeAuthMethod, safeLabel } from "./cliProviderValues.ts";

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

export function claudeCommand(
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
  const model = cleanString(input.model) || cleanString(config.model);
  if (model !== "" && model !== "codex-default") args.push("--model", model);
  args.push("--max-turns", DEFAULT_MAX_TURNS, cleanString(input.prompt));
  return [...command, ...args];
}

export function claudeNativePermissionMode(input: Pick<ProviderRunInput, "policy"> & { approvalPolicy?: string }): string {
  const native = input.policy?.nativeSummary.permissionMode;
  return typeof native === "string" && native.trim() !== "" ? native : claudePermissionMode(input.approvalPolicy);
}

export function claudeNativeAllowedTools(input: Pick<ProviderRunInput, "policy"> & { sandbox?: string }): string {
  const native = input.policy?.nativeSummary.tools;
  return Array.isArray(native) && native.every((item) => typeof item === "string")
    ? native.join(",")
    : claudeAllowedTools(input.sandbox);
}

export function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session?.sessionId) throw new Error("Claude CLI completed without a provider session id");
  return result.session;
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

export function claudeAllowedTools(sandbox?: string): string {
  return cleanString(sandbox).toLowerCase() === "read-only"
    ? "Read,Grep,Glob,LS"
    : "Read,Grep,Glob,LS,Edit,MultiEdit,Write,Bash";
}

export function claudePermissionMode(policy?: string): string {
  switch (cleanString(policy).toLowerCase()) {
    case "never":
    case "on-request":
    case "danger-only":
      return "dontAsk";
    default:
      return "default";
  }
}
