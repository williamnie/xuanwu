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
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { createQoderSdkFacade, type QoderSdkFacade } from "./sdkFacade.ts";
import { probeQoderRuntime, type QoderRuntimeProbe } from "./runtime.ts";

/**
 * P11：Qoder executor（SDK facade，Q0 freshness gate 已刷新）。
 * - terminal 收敛：只认主 SDKResultMessage；task_notification 仅表示子任务进度；
 * - session：SDK session_id（UUID）每条消息携带；recover 用 resume 续接；
 * - interrupt：Query.interrupt()。
 */

export type QoderExecutorProviderOptions = {
  facade?: QoderSdkFacade;
  readiness?: QoderRuntimeProbe;
};

export class QoderExecutorProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt"];
  private readonly facade: QoderSdkFacade;

  constructor(
    private readonly config: ProviderRuntimeConfig,
    private readonly options: QoderExecutorProviderOptions = {}
  ) {
    this.facade = options.facade ?? createQoderSdkFacade(config);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const outcome = await this.facade.run(input.prompt, { model: input.model });
    return {
      runId: `qoder-run-${input.issueId}`,
      session: outcome.sessionId ? { provider: this.id, sessionId: outcome.sessionId } : undefined
    };
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const outcome = await this.facade.run(input.prompt, { resume: input.session.sessionId, model: input.model });
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
    return (this.options.readiness ?? probeQoderRuntime(this.config)).status;
  }

  async stop(): Promise<void> {
    await this.facade.close();
  }
}
