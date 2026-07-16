import { CodexAdapter } from "./adapter.ts";
import { localImageInput, textInput } from "./threadLifecycle.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { AppEvent } from "../../events/bus.ts";
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
  SessionMessageResult,
  ProviderEvent
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
  resolveApproval?(requestId: string, decision: ApprovalDecision): Promise<unknown>;
};
export type CodexEventHandler = (event: ProviderEvent) => void;
export type CodexEventSource = { subscribe(handler: CodexEventHandler): () => void };
export type CodexAppEventSink = (event: AppEvent) => void;
type CodexRuntimeControl = { stop(): Promise<void> };

class CodexEventHub implements CodexEventSource {
  readonly handlers = new Set<CodexEventHandler>();

  publish(event: ProviderEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: CodexEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export class CodexExecutorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"] as const;
  readonly id = PROVIDER_CODEX;
  constructor(
    private readonly adapter: CodexIssueAdapter,
    private readonly developerInstructions = DEFAULT_DEVELOPER_INSTRUCTIONS,
    private readonly eventSource?: CodexEventSource,
    private readonly runtimeControl?: CodexRuntimeControl
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const initialized = await this.adapter.initialize();
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
    const stopForwarding = this.forwardRunEvents(input, thread.provider_session_id);
    try {
      const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox
      });
      input.onEvent?.(turnStartedEvent(turn, input, initialized));
      return { runId: runID(turn), session: sessionRef(turn) };
    } catch (error) {
      stopForwarding();
      throw error;
    }
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
      const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), turnOptions(input));
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
      return await this.adapter.steerTurn(threadID, turnID, codexUserInputs(input));
    }
    return await this.adapter.startTurn(threadID, codexUserInputs(input), turnOptions(input));
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const initialized = await this.adapter.initialize();
    const session = await this.adapter.resumeThread(input.session.sessionId);
    const threadID = session.provider_session_id || input.session.sessionId;
    const stopForwarding = this.forwardRunEvents(input, threadID);
    try {
      const turn = await this.adapter.startTurn(threadID, codexUserInputs(input), {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox
      });
      input.onEvent?.(turnStartedEvent(turn, input, initialized));
      return { runId: runID(turn), session: sessionRef(turn) };
    } catch (error) {
      stopForwarding();
      throw error;
    }
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

  async stop(): Promise<void> {
    await this.runtimeControl?.stop();
  }

  private async nameThread(threadID: string, issueID: number): Promise<void> {
    if (threadID === "") return;
    await this.adapter.setThreadName(threadID, `Issue #${issueID}`);
  }

  private forwardRunEvents(input: ProviderRunInput, threadID: string): () => void {
    if (!this.eventSource) return () => {};
    let stop = () => {};
    stop = this.eventSource.subscribe((event) => {
      if (!sameThreadEvent(event, threadID)) return;
      input.onEvent?.(event);
      if (terminalCodexEvent(event)) stop();
    });
    return stop;
  }
}

export function createCodexExecutorProvider(
  config: ProviderRuntimeConfig,
  appEventSink?: CodexAppEventSink
): CodexExecutorProvider {
  const events = new CodexEventHub();
  const publish = (event: ProviderEvent) => {
    events.publish(event);
    if (isApprovalProviderEvent(event)) appEventSink?.(codexProviderAppEvent(event));
  };
  const transport = new CodexStdioJsonRpcTransport(config, {
    onDiagnostic: publish,
    onEvent: publish
  });
  return new CodexExecutorProvider(new CodexAdapter(transport), DEFAULT_DEVELOPER_INSTRUCTIONS, events, transport);
}

export function codexProviderAppEvent(event: ProviderEvent): AppEvent {
  const rawPayload = payloadText(event.raw?.payload);
  return compactAppEvent({
    type: "codex.event",
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    method: event.raw?.method,
    raw_method: event.raw?.method,
    raw_payload: rawPayload,
    payload: rawPayload ?? payloadText(event.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error
  });
}


function isApprovalProviderEvent(event: ProviderEvent): boolean {
  return event.raw?.method === "approval/requested" ||
    event.raw?.method === "approval/resolved" ||
    event.raw?.method === "approval/fast_resolved";
}

function sessionRef(turn: TurnStartResult): ProviderRunResult["session"] {
  return { provider: PROVIDER_CODEX, sessionId: turn.provider_session_id, turnId: turn.turn_id };
}

function runID(turn: TurnStartResult): string {
  const turnID = turn.turn_id || "pending-turn";
  return `${PROVIDER_CODEX}:${turn.provider_session_id}:${turnID}`;
}

function turnStartedEvent(
  turn: TurnStartResult,
  input: ProviderRunInput,
  initialized: CodexInitializeResult
): ProviderEvent {
  const session = sessionRef(turn);
  return {
    provider: PROVIDER_CODEX,
    type: "turn_started",
    status: "inProgress",
    session,
    runEvent: normalizedRunEvent({
      kind: "started",
      metadata: {
        model: input.model,
        protocol_version: initialized.protocolVersion,
        provider_name: initialized.serverInfo?.name,
        provider_version: initialized.serverInfo?.version,
        service_tier: input.serviceTier
      },
      method: "turn/start",
      outcome: "running",
      provider: PROVIDER_CODEX,
      session
    })
  };
}

function createResult(threadID: string): SessionCreateResult {
  return { id: `${PROVIDER_CODEX}:${threadID}`, provider: PROVIDER_CODEX, provider_session_id: threadID, thread_id: threadID };
}

function threadOptions(input: SessionCreateInput, developerInstructions: string): Parameters<CodexAdapter["startThread"]>[0] {
  return compactOptions({
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    developerInstructions
  }) as Parameters<CodexAdapter["startThread"]>[0];
}

function turnOptions(input: Pick<SessionCreateInput, "approvalPolicy" | "model" | "reasoningEffort" | "serviceTier" | "sandbox">) {
  return compactOptions({
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox
  });
}

function codexUserInputs(input: { images?: ProviderRunInput["images"]; prompt?: string }) {
  const items = [textInput(input.prompt ?? "")];
  for (const image of input.images ?? []) {
    const path = image.path.trim();
    if (path !== "") items.push(localImageInput(path, image.detail));
  }
  return items;
}

function sameThreadEvent(event: ProviderEvent, threadID: string): boolean {
  return event.provider === PROVIDER_CODEX && event.session?.sessionId === threadID;
}

function terminalCodexEvent(event: ProviderEvent): boolean {
  return event.type === "done" || event.type === "error" || event.raw?.method === "turn/completed";
}

function compactOptions<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as Partial<T>;
}

function compactAppEvent(value: AppEvent): AppEvent {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
  ) as AppEvent;
}

function payloadText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}
