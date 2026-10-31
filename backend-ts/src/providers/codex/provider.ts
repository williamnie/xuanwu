import { CodexLoginError } from "../../pi/runtime/codexLoginCredentials.ts";
import { CodexAdapter } from "./adapter.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import type { ExecutorProvider, ApprovalDecision, InterruptInput, ProviderRecoveryInput, ProviderRunInput, ProviderRunResult, SessionCreateInput, SessionCreateResult, SessionListInput, SessionListResult, SessionMessageInput, SessionMessageResult, ProviderEvent } from "../types.ts";
import type { ThreadSummary } from "./adapter.ts";
import { CodexStdioJsonRpcTransport, type CodexProcessLease } from "./jsonRpc.ts";
import { recoverCodexRolloutExecEvents } from "./rolloutExecRecovery.ts";
import { publicCodexSessionDetail, publicCodexSessionSummary } from "./sessionHistory.ts";
import { CodexThreadNaming, type CodexThreadTitleGenerator } from "./threadNaming.ts";
import { PROVIDER_CODEX, CodexIssueAdapter, DEFAULT_DEVELOPER_INSTRUCTIONS, CodexEventSource, CodexRuntimeControl } from "./providerModel.ts";
import { turnStartedEvent, runID, sessionRef, createResult } from "./providerEvents.ts";
import { nativePolicyString, codexUserInputs, threadOptions, turnOptions, sameThreadEvent, providerEventItemID, terminalCodexEvent } from "./providerOptions.ts";

export class CodexExecutorProvider implements ExecutorProvider {
  private accountRefresh?: Promise<void>;
  readonly codexCredentialHome?: string;
  private readonly threadNaming: CodexThreadNaming;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"] as const;
  readonly id = PROVIDER_CODEX;
  readonly interruptScope = "turn" as const;
  constructor(
    private readonly adapter: CodexIssueAdapter,
    private readonly developerInstructions = DEFAULT_DEVELOPER_INSTRUCTIONS,
    private readonly eventSource?: CodexEventSource,
    private readonly runtimeControl?: CodexRuntimeControl,
    generateTitle?: CodexThreadTitleGenerator,
    credentialHome?: string
  ) {
    this.codexCredentialHome = credentialHome;
    this.threadNaming = new CodexThreadNaming(adapter, {
      generate: generateTitle,
      acquire: (owner) => this.acquire(owner),
      subscribe: eventSource ? (handler) => eventSource.subscribe(handler) : undefined
    });
  }

  async refreshCodexLogin(): Promise<void> {
    if (!this.adapter.refreshAccount) throw new CodexLoginError("codex_account_unavailable");
    this.accountRefresh ??= this.adapter.refreshAccount().catch(error => {
      const text = error instanceof Error ? error.message : "";
      throw new CodexLoginError(/method not found|unknown method|not supported|-32601/i.test(text)
        ? "codex_account_unavailable" : text === "codex_login_unsupported" ? text : "codex_login_refresh_failed");
    });
    const pending = this.accountRefresh;
    try { await pending; } finally { if (this.accountRefresh === pending) this.accountRefresh = undefined; }
  }

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
        approvalPolicy: nativePolicyString(input, "approvalPolicy", input.approvalPolicy),
        sandbox: nativePolicyString(input, "sandbox", input.sandbox),
        developerInstructions: this.developerInstructions,
        threadSource: "subagent"
      });
      lease.bind(thread.provider_session_id);
      input.onEvent?.(providerSessionStartedEvent(this.id, thread.provider_session_id, {
        method: "thread/started",
        metadata: { protocol_version: initialized.protocolVersion }
      }));
      const hasName = typeof thread.name === "string" && thread.name.trim() !== "";
      if (!hasName) {
        await this.nameThread(thread.provider_session_id, input.issueId);
        thread.name = `Issue #${input.issueId}`;
      }
      stopForwarding = this.forwardRunEvents(input, thread, () => lease.release());
      const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        approvalPolicy: nativePolicyString(input, "approvalPolicy", input.approvalPolicy),
        sandbox: nativePolicyString(input, "sandbox", input.sandbox)
      });
      lease.bind(turn.provider_session_id, turn.turn_id);
      input.onEvent?.(turnStartedEvent(turn, input, initialized));
      if (!hasName) this.threadNaming.schedule({ ...input, thread });
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

  async readSession(sessionId: string, input: { includeTurns?: boolean } = {}) {
    await this.adapter.initialize();
    return publicCodexSessionDetail(await this.adapter.readThread(sessionId.trim(), {
      includeTurns: input.includeTurns !== false
    }));
  }

  async listSessionTurns(sessionId: string, input: Parameters<CodexAdapter["listThreadTurns"]>[1] = {}) {
    await this.adapter.initialize();
    return this.adapter.listThreadTurns(sessionId.trim(), input);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const lease = this.acquire(`project:${input.projectId ?? "manual"}:session:create`);
    try {
      await this.adapter.initialize();
      const thread = await this.adapter.startThread({ ...threadOptions(input, this.developerInstructions), threadSource: "user" });
      lease.bind(thread.provider_session_id);
      const title = input.title?.trim();
      if (title) await this.adapter.setThreadName(thread.provider_session_id, title);
      const result = createResult(thread.provider_session_id);
      if (input.prompt?.trim()) {
        const turn = await this.adapter.startTurn(thread.provider_session_id, codexUserInputs(input), turnOptions(input));
        lease.bind(turn.provider_session_id, turn.turn_id);
        result.turn_id = turn.turn_id;
        result.provider_turn_id = turn.turn_id;
        if (!title && !thread.name) this.threadNaming.schedule({ ...input, prompt: input.prompt, thread });
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
      if (!session.name) this.threadNaming.schedule({ ...input, prompt: input.prompt ?? "", thread: session });
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
        approvalPolicy: nativePolicyString(input, "approvalPolicy", input.approvalPolicy),
        sandbox: nativePolicyString(input, "sandbox", input.sandbox)
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
    this.threadNaming.stop();
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

export { type CodexEventHandler, type CodexAppEventSink } from "./providerModel.ts";
export { createCodexExecutorProvider } from "./providerEvents.ts";
