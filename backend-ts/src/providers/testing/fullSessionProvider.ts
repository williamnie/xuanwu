import type {
  ApprovalDecision,
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderEvent,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  SessionCreateInput,
  SessionCreateResult,
  SessionListInput,
  SessionListResult,
  SessionMessageInput,
  SessionMessageResult,
  SessionRef
} from "../types.ts";
import { providerSessionDetail, providerSessionSummary } from "../core/sessionView.ts";

/**
 * P0 fixture：full-session 形态（Codex-like）。
 *
 * 声明全部 Session/control/approval/model_list capability，
 * 用于 snapshot Codex tested 路径的基线行为，并作为契约的完整实现参考。
 * 与真实 Codex adapter 的差异：无真实进程/SDK，纯内存状态。
 */
export class FullSessionProvider implements ExecutorProvider {
  readonly id = "fake-full-session" as const;
  readonly capabilities: readonly ExecutorCapability[] = [
    "issue_execution",
    "sessions",
    "resume_session",
    "interrupt",
    "approvals",
    "model_list"
  ];
  readonly runs: Array<{ input: ProviderRunInput; recovered?: boolean }> = [];
  readonly sessions = new Map<string, { created: string; messages: number; turn: number }>();
  readonly interrupts: InterruptInput[] = [];

  #ref(input: ProviderRunInput): SessionRef {
    const sessionId = `fake-full-session-${input.projectId}`;
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { created: new Date().toISOString(), messages: 0, turn: 1 });
    const session = this.sessions.get(sessionId)!;
    return { provider: this.id, sessionId, turnId: `turn-${session.turn}` };
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.runs.push({ input });
    const ref = this.#ref(input);
    const session = this.sessions.get(ref.sessionId)!;
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session: ref,
      text: "full-session provider started"
    });
    session.messages += 1;
    session.turn += 1;
    return { runId: `fake-full-run-${input.issueId}`, session: ref };
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.runs.push({ input, recovered: true });
    const ref = input.session;
    const session = this.sessions.get(ref.sessionId) ?? { created: new Date().toISOString(), messages: 0, turn: 1 };
    this.sessions.set(ref.sessionId, session);
    session.messages += 1;
    session.turn += 1;
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session: { ...ref, turnId: `turn-${session.turn}` },
      text: "full-session provider recovered"
    });
    return {
      runId: `fake-full-run-${input.issueId}`,
      session: { ...ref, turnId: `turn-${session.turn}` }
    };
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const sessionId = `fake-full-created-${input.projectId ?? "p"}`;
    this.sessions.set(sessionId, { created: new Date().toISOString(), messages: 0, turn: 0 });
    return {
      id: sessionId,
      provider: this.id,
      provider_session_id: sessionId,
      thread_id: sessionId,
      turn_id: undefined
    };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }

  async listSessions(_input: SessionListInput): Promise<SessionListResult> {
    return {
      data: [...this.sessions.entries()].map(([id, s]) => providerSessionSummary(this.id, {
        sessionRef: id,
        name: `fake session ${id}`,
        createdAt: Math.floor(Date.parse(s.created) / 1000),
        updatedAt: Math.floor(Date.parse(s.created) / 1000)
      })),
      nextCursor: undefined
    };
  }

  async readSession(sessionId: string): Promise<Record<string, unknown>> {
    return providerSessionDetail(this.id, {
      sessionRef: sessionId,
      name: `fake session ${sessionId}`,
      turns: []
    });
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    const session = this.sessions.get(input.sessionId) ?? { created: new Date().toISOString(), messages: 0, turn: 1 };
    session.messages += 1;
    this.sessions.set(input.sessionId, session);
    return {
      provider: this.id,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: `turn-${session.turn}`
    };
  }

  async listModels(): Promise<unknown> {
    return [{ id: "fake-model", display_name: "Fake Model" }];
  }

  async resolveApproval(_requestId: string, _decision: ApprovalDecision): Promise<void> {
    // P2：full-session fixture 声明 approvals=host-callback，需提供对应方法（conformance fail closed）
  }
}
