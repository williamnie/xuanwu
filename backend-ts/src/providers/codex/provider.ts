import { CodexAdapter } from "./adapter.ts";
import { textInput } from "./threadLifecycle.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type {
  ExecutorProvider,
  ApprovalDecision,
  InterruptInput,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  SessionCreateInput,
  SessionCreateResult,
  SessionListInput,
  SessionListResult,
  SessionMessageInput,
  SessionMessageResult
} from "../types.ts";
import type { CodexInitializeResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import { CodexStdioJsonRpcTransport } from "./jsonRpc.ts";

const PROVIDER_CODEX = "codex";
const DEFAULT_DEVELOPER_INSTRUCTIONS = "Keep changes scoped to the runner issue and explicitly update the issue status when done.";

type CodexIssueAdapter = {
  initialize(): Promise<CodexInitializeResult>;
  listThreads(input?: Parameters<CodexAdapter["listThreads"]>[0]): Promise<Awaited<ReturnType<CodexAdapter["listThreads"]>>>;
  readThread(threadID: string): Promise<ThreadSummary>;
  resumeThread(threadID: string): Promise<ThreadSummary>;
  setThreadName(threadID: string, name: string): Promise<{ ok: true; provider_session_id: string }>;
  startThread(input: Parameters<CodexAdapter["startThread"]>[0]): Promise<Awaited<ReturnType<CodexAdapter["startThread"]>>>;
  startTurn(threadID: string, input: Parameters<CodexAdapter["startTurn"]>[1], options?: Parameters<CodexAdapter["startTurn"]>[2]): Promise<TurnStartResult>;
  steerTurn(threadID: string, turnID: string, input: Parameters<CodexAdapter["steerTurn"]>[2]): Promise<TurnStartResult>;
  interruptTurn(threadID: string, turnID: string): Promise<Awaited<ReturnType<CodexAdapter["interruptTurn"]>>>;
  listModels(): Promise<unknown>;
  resolveApproval?(requestId: string, decision: ApprovalDecision): Promise<void>;
};

export class CodexExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"] as const;
  readonly id = PROVIDER_CODEX;
  constructor(
    private readonly adapter: CodexIssueAdapter,
    private readonly developerInstructions = DEFAULT_DEVELOPER_INSTRUCTIONS
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    await this.adapter.initialize();
    const thread = await this.adapter.startThread({
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      developerInstructions: this.developerInstructions,
      threadSource: "subagent"
    });
    await this.nameThread(thread.provider_session_id, input.issueId);
    const turn = await this.adapter.startTurn(thread.provider_session_id, [textInput(input.prompt)], {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox
    });
    input.onEvent?.({ provider: PROVIDER_CODEX, type: "turn_started", status: "inProgress", session: sessionRef(turn) });
    return { runId: runID(turn), session: sessionRef(turn) };
  }

  async listSessions(input: SessionListInput = {}): Promise<SessionListResult> {
    await this.adapter.initialize();
    return await this.adapter.listThreads(input);
  }

  async readSession(sessionId: string): Promise<ThreadSummary> {
    await this.adapter.initialize();
    return await this.adapter.resumeThread(sessionId.trim());
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    await this.adapter.initialize();
    const thread = await this.adapter.startThread({ ...threadOptions(input, this.developerInstructions), threadSource: "user" });
    const result = createResult(thread.provider_session_id);
    if (input.prompt?.trim()) {
      const turn = await this.adapter.startTurn(thread.provider_session_id, [textInput(input.prompt)], turnOptions(input));
      result.turn_id = turn.turn_id;
      result.provider_turn_id = turn.turn_id;
    }
    return result;
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    await this.adapter.initialize();
    const threadID = input.sessionId.trim();
    if (input.mode?.trim() === "steer") {
      const turnID = input.turnId?.trim() ?? "";
      if (turnID === "") throw new Error("当前 session 没有可引导的运行中 turn");
      return await this.adapter.steerTurn(threadID, turnID, [textInput(input.prompt ?? "")]);
    }
    return await this.adapter.startTurn(threadID, [textInput(input.prompt ?? "")], turnOptions(input));
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    await this.adapter.initialize();
    const session = await this.adapter.resumeThread(input.session.sessionId);
    const threadID = session.provider_session_id || input.session.sessionId;
    const turn = await this.adapter.startTurn(threadID, [textInput(input.prompt)], {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox
    });
    input.onEvent?.({ provider: PROVIDER_CODEX, type: "turn_started", status: "inProgress", session: sessionRef(turn) });
    return { runId: runID(turn), session: sessionRef(turn) };
  }

  async listModels(): Promise<unknown> {
    await this.adapter.initialize();
    return await this.adapter.listModels();
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.adapter.resolveApproval) throw new Error("provider codex 暂不支持 approval resolve");
    await this.adapter.resolveApproval(requestId, decision);
  }

  async interrupt(input: InterruptInput): Promise<void> {
    await this.adapter.initialize();
    const threadID = input.session.sessionId.trim();
    const turnID = input.session.turnId?.trim() ?? "";
    if (threadID === "" || turnID === "") throw new Error("codex interrupt requires thread and turn ids");
    await this.adapter.interruptTurn(threadID, turnID);
  }

  private async nameThread(threadID: string, issueID: number): Promise<void> {
    if (threadID === "") return;
    await this.adapter.setThreadName(threadID, `Issue #${issueID}`);
  }
}

export function createCodexExecutorProvider(config: ProviderRuntimeConfig): CodexExecutorProvider {
  const transport = new CodexStdioJsonRpcTransport(config);
  return new CodexExecutorProvider(new CodexAdapter(transport));
}

function sessionRef(turn: TurnStartResult): ProviderRunResult["session"] {
  return { provider: PROVIDER_CODEX, sessionId: turn.provider_session_id, turnId: turn.turn_id };
}

function runID(turn: TurnStartResult): string {
  const turnID = turn.turn_id || "pending-turn";
  return `${PROVIDER_CODEX}:${turn.provider_session_id}:${turnID}`;
}

function createResult(threadID: string): SessionCreateResult {
  return { id: `${PROVIDER_CODEX}:${threadID}`, provider: PROVIDER_CODEX, provider_session_id: threadID, thread_id: threadID };
}

function threadOptions(input: SessionCreateInput, developerInstructions: string): Parameters<CodexAdapter["startThread"]>[0] {
  return {
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    developerInstructions
  };
}

function turnOptions(input: Pick<SessionCreateInput, "approvalPolicy" | "model" | "reasoningEffort" | "serviceTier" | "sandbox">) {
  return {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox
  };
}
