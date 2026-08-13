import { CodexAdapter } from "./adapter.ts";
import { localImageInput, textInput } from "./threadLifecycle.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
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
import { CodexStdioJsonRpcTransport, type CodexProcessLease } from "./jsonRpc.ts";
import { recoverCodexRolloutExecEvents } from "./rolloutExecRecovery.ts";
import { publicCodexSessionDetail, publicCodexSessionSummary } from "./sessionHistory.ts";

const PROVIDER_CODEX = "codex";
const DEFAULT_DEVELOPER_INSTRUCTIONS = [
  "Keep changes scoped to the runner issue.",
  "You are executing an Issue already claimed by Xuanwu. Never use Xuanwu CLI or API lifecycle commands to create, deduplicate, enqueue, retry, cancel, delete, or change the status of the current Issue, and never stop its current Run.",
  "Report the result with the RUNNER_OUTCOME marker required by the execution context; the Host reconciles the Run and PI alone decides semantic Issue status."
].join(" ");

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
type CodexRuntimeControl = {
  acquire(owner: string): CodexProcessLease;
  releaseSession(sessionID: string, turnID?: string): void;
  runtimeSnapshot(): ReturnType<CodexStdioJsonRpcTransport["runtimeSnapshot"]>;
  stop(): Promise<void>;
};

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
  readonly interruptScope = "turn" as const;
  constructor(
    private readonly adapter: CodexIssueAdapter,
    private readonly developerInstructions = DEFAULT_DEVELOPER_INSTRUCTIONS,
    private readonly eventSource?: CodexEventSource,
    private readonly runtimeControl?: CodexRuntimeControl
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const lease = this.acquire(`project:${input.projectId}:issue:${input.issueId}:run`);
    let stopForwarding = () => {};
    try {
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
      lease.bind(thread.provider_session_id);
      input.onEvent?.(providerSessionStartedEvent(this.id, thread.provider_session_id, {
        method: "thread/started",
        metadata: { protocol_version: initialized.protocolVersion }
      }));
      await this.nameThread(thread.provider_session_id, input.issueId);
      stopForwarding = this.forwardRunEvents(input, thread, () => lease.release());
      const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox
      });
      lease.bind(turn.provider_session_id, turn.turn_id);
      input.onEvent?.(turnStartedEvent(turn, input, initialized));
      return { runId: runID(turn), session: sessionRef(turn) };
    } catch (error) {
      stopForwarding();
      lease.release();
      throw error;
    }
  }

  async listSessions(input: SessionListInput = {}): Promise<SessionListResult> {
    await this.adapter.initialize();
    const result = await this.adapter.listThreads(input);
    return { ...result, data: result.data.map(publicCodexSessionSummary) };
  }

  async readSession(sessionId: string) {
    await this.adapter.initialize();
    return publicCodexSessionDetail(await this.adapter.readThread(sessionId.trim()));
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const lease = this.acquire(`project:${input.projectId ?? "manual"}:session:create`);
    try {
      await this.adapter.initialize();
      const thread = await this.adapter.startThread({ ...threadOptions(input, this.developerInstructions), threadSource: "user" });
      lease.bind(thread.provider_session_id);
      const result = createResult(thread.provider_session_id);
      if (input.prompt?.trim()) {
        const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), turnOptions(input));
        lease.bind(turn.provider_session_id, turn.turn_id);
        result.turn_id = turn.turn_id;
        result.provider_turn_id = turn.turn_id;
      } else {
        lease.release();
      }
      return result;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    const threadID = input.sessionId.trim();
    const lease = this.acquire(`session:${threadID}:message`);
    lease.bind(threadID, input.turnId);
    try {
      await this.adapter.initialize();
      if (input.mode?.trim() === "steer") {
        const turnID = input.turnId?.trim() ?? "";
        if (turnID === "") throw new Error("当前 session 没有可引导的运行中 turn");
        const turn = await this.adapter.steerTurn(threadID, turnID, codexUserInputs(input));
        lease.bind(turn.provider_session_id, turn.turn_id);
        return turn;
      }
      const session = await this.adapter.resumeThread(threadID);
      const resumedThreadID = session.provider_session_id || threadID;
      lease.bind(resumedThreadID);
      const turn = await this.adapter.startTurn(resumedThreadID, codexUserInputs(input), turnOptions(input));
      lease.bind(turn.provider_session_id, turn.turn_id);
      return turn;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const lease = this.acquire(`project:${input.projectId}:issue:${input.issueId}:recovery`);
    let stopForwarding = () => {};
    try {
      const initialized = await this.adapter.initialize();
      const session = await this.adapter.resumeThread(input.session.sessionId);
      const threadID = session.provider_session_id || input.session.sessionId;
      lease.bind(threadID);
      input.onEvent?.(providerSessionStartedEvent(this.id, threadID, {
        method: "thread/resumed",
        metadata: { protocol_version: initialized.protocolVersion }
      }));
      stopForwarding = this.forwardRunEvents(input, session, () => lease.release());
      const turn = await this.adapter.startTurn(threadID, codexUserInputs(input), {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox
      });
      lease.bind(turn.provider_session_id, turn.turn_id);
      input.onEvent?.(turnStartedEvent(turn, input, initialized));
      return { runId: runID(turn), session: sessionRef(turn) };
    } catch (error) {
      stopForwarding();
      lease.release();
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
    this.runtimeControl?.releaseSession(threadID, turnID);
  }

  async stop(): Promise<void> {
    await this.runtimeControl?.stop();
  }

  runtimeSnapshot(): ReturnType<CodexStdioJsonRpcTransport["runtimeSnapshot"]> | undefined {
    return this.runtimeControl?.runtimeSnapshot();
  }

  private acquire(owner: string): CodexProcessLease {
    return this.runtimeControl?.acquire(owner) ?? { bind: () => {}, release: () => {} };
  }

  private async nameThread(threadID: string, issueID: number): Promise<void> {
    if (threadID === "") return;
    await this.adapter.setThreadName(threadID, `Issue #${issueID}`);
  }

  private forwardRunEvents(input: ProviderRunInput, thread: ThreadSummary, release: () => void): () => void {
    if (!this.eventSource) return () => {};
    const threadID = thread.provider_session_id;
    let stop = () => {};
    let terminalPending = false;
    const observedItemIDs = new Set<string>();
    stop = this.eventSource.subscribe((event) => {
      if (!sameThreadEvent(event, threadID)) return;
      const itemID = providerEventItemID(event);
      if (itemID !== "") observedItemIDs.add(itemID);
      if (terminalCodexEvent(event)) {
        if (terminalPending) return;
        terminalPending = true;
        stop();
        void this.recoverTerminalExecEvents(thread, event, observedItemIDs)
          .then((events) => {
            for (const recovered of events) input.onEvent?.(recovered);
          })
          .finally(() => {
            input.onEvent?.(event);
            release();
          });
        return;
      }
      input.onEvent?.(event);
    });
    return stop;
  }

  private async recoverTerminalExecEvents(
    thread: ThreadSummary,
    terminal: ProviderEvent,
    observedItemIDs: ReadonlySet<string>
  ): Promise<ProviderEvent[]> {
    try {
      const recovered = await recoverCodexRolloutExecEvents(thread, terminal.session?.turnId ?? "");
      return recovered.filter((event) => {
        const id = providerEventItemID(event);
        return id === "" || !observedItemIDs.has(id);
      });
    } catch {
      // Recovery is best-effort; the original terminal event must always win.
      return [];
    }
  }
}

export function createCodexExecutorProvider(
  config: ProviderRuntimeConfig,
  appEventSink?: CodexAppEventSink,
  options: { ownershipFile?: string } = {}
): CodexExecutorProvider {
  const events = new CodexEventHub();
  const publish = (event: ProviderEvent) => {
    events.publish(event);
    if (isApprovalProviderEvent(event)) appEventSink?.(codexProviderAppEvent(event));
  };
  const transport = new CodexStdioJsonRpcTransport(config, {
    onDiagnostic: publish,
    onEvent: publish,
    ownershipFile: options.ownershipFile
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

function providerEventItemID(event: ProviderEvent): string {
  const payload = event.raw?.payload;
  if (typeof payload !== "string" || payload === "") return "";
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const item = (parsed as Record<string, unknown>).item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" ? id.trim() : "";
  } catch {
    return "";
  }
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
