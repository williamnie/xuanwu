import type { AuthOptions, Options, Query, SDKMessage, Transport } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { qoderPermissionOptions } from "./permissionBroker.ts";
import { cleanString } from "../../util/values.ts";
import { QoderRunOptions, QODER_HOST_ENV_KEYS, QoderTerminal, QoderSdkFacadeOptions, QoderSdkFacade } from "./sdkFacadeModel.ts";
import { RealQoderSdkFacade } from "./sdkFacadeRuntime.ts";
import { qoderModelPolicy } from "./sdkFacadeFixture.ts";

export function buildQoderQueryOptions(
  options: Partial<QoderRunOptions> = {},
  runtime?: ProviderRuntimeConfig
): Pick<Options,
  "abortController" | "allowDangerouslySkipPermissions" | "allowedTools" | "auth" | "canUseTool" | "cwd" | "disallowedTools" | "env" | "model" |
  "pathToQoderCLIExecutable" | "permissionMode" | "resolveModel" | "resume" | "sessionId" | "systemPrompt" | "tools"
> {
  const policy = qoderPermissionOptions(options.approvalPolicy, options.sandbox, options.canUseTool, options.policy);
  const model = cleanString(options.model) || cleanString(runtime?.model);
  const resolveModel = qoderModelPolicy(model, options.reasoningEffort);
  const systemPrompt = cleanString(options.systemPrompt);
  return {
    ...(runtime ? {
      auth: buildQoderAuthOptions(runtime),
      env: managedExecutionEnvironment({
        ...qoderHostEnvironment(),
        ...runtime.env,
        ...(runtime.configDir ? { QODER_CONFIG_DIR: runtime.configDir } : {})
      }),
      pathToQoderCLIExecutable: runtime.command
    } : {}),
    ...policy,
    cwd: cleanString(options.cwd) || undefined,
    model: resolveModel ? undefined : model || undefined,
    resolveModel,
    resume: cleanString(options.resume) || undefined,
    sessionId: cleanString(options.resume) === "" ? cleanString(options.sessionId) || undefined : undefined,
    systemPrompt: systemPrompt ? { type: "preset", preset: "qodercli", append: systemPrompt } : undefined
  };
}

export function qoderHostEnvironment(
  environment: Record<string, string | undefined> = process.env
): Record<string, string> {
  return Object.fromEntries(QODER_HOST_ENV_KEYS.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [[key, value]] : [];
  }));
}

export function buildQoderAuthOptions(config: ProviderRuntimeConfig): AuthOptions {
  switch (config.authMode) {
    case "pat-env":
      return { type: "accessToken", accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" } };
    case "pat-secret-ref":
      return { type: "accessToken", accessToken: config.credential ?? "" };
    case "service-account-secret-ref":
      return { type: "serviceAccount", serviceAccountKey: config.credential ?? "" };
    case "local-cli":
    default:
      return { type: "qodercli" };
  }
}

/** 只有主 result 能结束本轮；task_notification 是 Sub-Agent task 进度。 */
export function qoderMessageTerminal(message: SDKMessage): QoderTerminal | undefined {
  if (message.type !== "result") return undefined;
  return message.subtype === "success" && message.is_error === false ? "succeeded" : "failed";
}

export function createQoderSdkFacade(
  config: ProviderRuntimeConfig,
  options: QoderSdkFacadeOptions = {}
): QoderSdkFacade {
  return new RealQoderSdkFacade(config, options);
}

export type ActiveQuery = {
  controller: AbortController;
  interruptAcknowledged: boolean;
  interruptRequested: boolean;
  query?: Query;
  sessionId: string;
  startedAt: string;
  timedOut: boolean;
  transport?: Transport & { pid?: number };
};
export { QODER_VERSION_PAIR } from "./version.ts";
export { type QoderRunOptions, type QoderQueryResult, type QoderUsageProjection, QoderExecutionError, type QoderSdkFacade } from "./sdkFacadeModel.ts";
export { createFakeQoderSdkFacade } from "./sdkFacadeFixture.ts";
