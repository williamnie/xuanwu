import { type Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { AppEvent } from "../../events/bus.ts";
import { claudeProcessEnvironment } from "./auth.ts";
import { claudeTranscriptContent } from "./sessionHistory.ts";
import { type ProviderEvent, type ProviderRunInput, type SessionCreateInput } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { DEFAULT_MAX_TURNS } from "./sdkProviderModel.ts";
import { resolveClaudeSdkExecutable } from "./sdkExecutable.ts";
import { compactAppEvent, claudeTools, claudeEffort, claudePermissionMode } from "./sdkProviderValues.ts";

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

export function sdkInput(
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

export function nativePermissionMode(input: Pick<ProviderRunInput, "policy">): ClaudeSdkOptions["permissionMode"] | undefined {
  const value = input.policy?.nativeSummary.permissionMode;
  return typeof value === "string" ? value as ClaudeSdkOptions["permissionMode"] : undefined;
}

export function nativeStringArray(input: Pick<ProviderRunInput, "policy">, key: string): string[] | undefined {
  const value = input.policy?.nativeSummary[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

export function nativeBoolean(input: Pick<ProviderRunInput, "policy">, key: string): boolean {
  return input.policy?.nativeSummary[key] === true;
}
