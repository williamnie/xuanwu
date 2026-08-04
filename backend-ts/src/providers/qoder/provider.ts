import type {
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  ProviderRuntimeStatus,
  SessionCreateInput,
  SessionCreateResult,
  SessionRef
} from "../types.ts";
import { createQoderSdkFacade, type QoderSdkFacade } from "./sdkFacade.ts";

/**
 * P11：Qoder executor（SDK facade，G11 gate 已通过）。
 * - terminal 收敛：task_notification（completed/failed/stopped）/ mirror_error；
 * - session：SDK session_id（UUID）每条消息携带；recover 用 sessionId 续接；
 * - interrupt：Query.interrupt()。
 */

export type QoderExecutorProviderOptions = {
  facade?: QoderSdkFacade;
};

export class QoderExecutorProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt"];
  private readonly facade: QoderSdkFacade;

  constructor(options: QoderExecutorProviderOptions = {}) {
    this.facade = options.facade ?? createQoderSdkFacade();
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const outcome = await this.facade.run(input.prompt, { model: input.model });
    return {
      runId: `qoder-run-${input.issueId}`,
      session: outcome.sessionId ? { provider: this.id, sessionId: outcome.sessionId } : undefined
    };
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const outcome = await this.facade.run(input.prompt, { sessionId: input.session.sessionId, model: input.model });
    return {
      runId: `qoder-recover-${input.issueId}`,
      session: outcome.sessionId ? { provider: this.id, sessionId: outcome.sessionId } : undefined
    };
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const outcome = await this.facade.run(input.prompt ?? "", { model: input.model });
    const sessionId = outcome.sessionId;
    return {
      id: sessionId,
      provider: this.id,
      provider_session_id: sessionId,
      thread_id: sessionId,
      turn_id: undefined
    };
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    await this.facade.interrupt();
  }

  runtimeStatus(): ProviderRuntimeStatus {
    return {
      active_sessions: 0,
      api_key_configured: false,
      auth_configured: true,
      auth_source: "qodercli-local",
      executable_ready: this.facade.available,
      mode: "sdk",
      ready: this.facade.available,
      version: "1.0.17"
    };
  }

  async stop(): Promise<void> {
    await this.facade.close();
  }
}
