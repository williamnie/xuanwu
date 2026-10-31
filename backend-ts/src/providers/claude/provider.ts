import type { SessionReadInput } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { ClaudeCliExecutorProvider } from "./cliProvider.ts";
import { type ExecutorCapability, type ExecutorProvider, type InterruptInput, type ProviderEvent, type ProviderRecoveryInput, type ProviderRunInput, type ProviderRuntimeStatus, type SessionCreateInput, type SessionListInput, type SessionMessageInput } from "../types.ts";
import { cleanString } from "../../util/values.ts";
import { PROVIDER, ClaudeProviderOptions } from "./sdkProviderModel.ts";
import { ClaudeSdkExecutorProvider } from "./sdkExecutorProvider.ts";
import { requireMethod } from "./sdkProviderValues.ts";

export class ClaudeExecutorProvider implements ExecutorProvider {
  readonly id = PROVIDER;
  private readonly delegate: ExecutorProvider & { runtimeStatus?: () => ProviderRuntimeStatus };

  constructor(private readonly config: ProviderRuntimeConfig, options: ClaudeProviderOptions = {}) {
    const cliFallback = config.mode === "cli-fallback" || (config.mode === undefined && Boolean(options.processFactory) && !options.queryFactory);
    this.delegate = cliFallback
      ? new ClaudeCliExecutorProvider(config, {
        authInspector: options.authInspector,
        processFactory: options.processFactory,
        sessionIdFactory: options.sessionIdFactory,
        sessionFunctions: options.sessionFunctions
      })
      : new ClaudeSdkExecutorProvider(config, options);
  }

  get capabilities(): readonly ExecutorCapability[] { return this.delegate.capabilities; }
  get interruptScope(): ExecutorProvider["interruptScope"] { return this.delegate.interruptScope; }
  run(input: ProviderRunInput) { return this.delegate.run(input); }
  createSession(input: SessionCreateInput) { return requireMethod(this.delegate.createSession, "sessions").call(this.delegate, input); }
  recover(input: ProviderRecoveryInput) { return requireMethod(this.delegate.recover, "resume_session").call(this.delegate, input); }
  interrupt(input: InterruptInput) { return requireMethod(this.delegate.interrupt, "interrupt").call(this.delegate, input); }
  listSessions(input: SessionListInput) { return requireMethod(this.delegate.listSessions, "sessions").call(this.delegate, input); }
  readSession(sessionId: string, input?: SessionReadInput) { return requireMethod(this.delegate.readSession, "sessions").call(this.delegate, sessionId, input); }
  resolveApproval(requestId: string, decision: import("../types.ts").ApprovalDecision) {
    return requireMethod(this.delegate.resolveApproval, "approvals").call(this.delegate, requestId, decision);
  }
  sendSessionMessage(input: SessionMessageInput) { return requireMethod(this.delegate.sendSessionMessage, "resume_session").call(this.delegate, input); }
  stop() { return this.delegate.stop?.() ?? Promise.resolve(); }

  runtimeStatus(): ProviderRuntimeStatus {
    return this.delegate.runtimeStatus?.() ?? {
      ready: true,
      mode: "cli-fallback",
      version: "",
      active_sessions: 0,
      api_key_configured: cleanString(this.config.env.ANTHROPIC_API_KEY) !== ""
    };
  }
}

export function createClaudeExecutorProvider(
  config: ProviderRuntimeConfig,
  eventSink?: (event: ProviderEvent) => void
): ClaudeExecutorProvider {
  return new ClaudeExecutorProvider(config, { eventSink });
}
export type { ClaudeProcessFactory } from "./cliProvider.ts";
export { CLAUDE_AGENT_SDK_VERSION, type ClaudeQuery, type ClaudeQueryFactory } from "./sdkProviderModel.ts";
export { ClaudeSdkExecutorProvider } from "./sdkExecutorProvider.ts";
export { claudeProviderAppEvent } from "./sdkProviderOptions.ts";
export { resolveClaudeSdkExecutable } from "./sdkExecutable.ts";
