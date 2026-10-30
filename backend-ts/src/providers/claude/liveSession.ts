import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { ProviderInterruptedError, type ProviderEvent, type ProviderRunResult } from "../types.ts";
import { interruptedClaudeSdkEvent, projectClaudeSdkMessage, timedOutClaudeSdkEvent } from "./sdkStream.ts";
import { ClaudeTranscriptSnapshot } from "./liveSessionSnapshot.ts";
import { type Turn, createClaudeLiveTurn, userMessage, sessionRef, scratchState, asProgress } from "./liveSessionTurn.ts";
import { type LiveProcess, type ClaudeLiveSessionHost, type ClaudeLiveTurnRequest, type ClaudeLiveSubmission, INTERRUPT_GRACE_MS, boundedInterrupt, ACCEPT_WAIT_MS, createInputQueue, CLAUDE_SESSION_STATE_EVENTS_ENV } from "./liveSessionModel.ts";

/**
 * 一个 Claude 会话对应一个常驻 SDK Query：普通消息在本地串行排队（CLI 会把排队消息合并成一轮，
 * 不能直接塞给它），steer 以 priority "next" 直接写入，由 CLI 在下一个工具边界并入当前轮。
 * 一轮从派发开始，到 CLI 报告 idle 为止；idle 之前到达的 result 先扣住，避免 steer 衍生的续轮
 * 被上游当成提前结束。
 */
export class ClaudeLiveSession {
  private readonly transcriptSnapshot: ClaudeTranscriptSnapshot;
  private proc?: LiveProcess;
  private current?: Turn;
  private readonly pending: Turn[] = [];
  private pumping = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  private transcriptExists: boolean;

  constructor(readonly sessionId: string, private readonly host: ClaudeLiveSessionHost, resumed: boolean) {
    this.transcriptExists = resumed;
    this.transcriptSnapshot = new ClaudeTranscriptSnapshot(sessionId, host, () => !this.current);
  }

  get running(): boolean {
    return Boolean(this.current);
  }

  get alive(): boolean {
    return Boolean(this.proc);
  }

  submit(request: ClaudeLiveTurnRequest): ClaudeLiveSubmission {
    const { turn, accepted, acceptedPromise, done } = createClaudeLiveTurn(request, this.sessionId);
    this.pending.push(turn);
    if (this.current) accepted();
    void this.pump();
    return { turnId: request.id, accepted: acceptedPromise, done };
  }

  steer(prompt: string): string {
    const turn = this.current;
    if (!turn || !this.proc) throw new Error("当前 session 没有可引导的运行中 turn");
    this.proc.input.push(userMessage(crypto.randomUUID(), this.sessionId, prompt, "next"));
    return turn.request.id;
  }

  /** 有运行中的轮则中断它（进程保留）；空闲时释放常驻进程，便于在终端 `claude --resume` 接手。 */
  async interrupt(reason: string): Promise<boolean> {
    const turn = this.current;
    if (!turn) {
      if (!this.proc) return false;
      this.closeProcess("released for terminal handoff");
      return true;
    }
    turn.interrupted = reason;
    turn.request.rejectApprovals("Claude invocation interrupted while approval was pending");
    for (const queued of this.pending.splice(0)) queued.reject(new ProviderInterruptedError(reason));
    const proc = this.proc;
    const grace = setTimeout(() => {
      if (this.current === turn && this.proc === proc) this.closeProcess(reason);
    }, INTERRUPT_GRACE_MS);
    grace.unref?.();
    try {
      await boundedInterrupt(proc?.query, 200);
    } catch {
      if (this.current === turn) this.closeProcess(reason);
    }
    return true;
  }

  close(reason: string): void {
    for (const queued of this.pending.splice(0)) queued.reject(new ProviderInterruptedError(reason));
    if (this.current) this.current.interrupted ??= reason;
    this.closeProcess(reason);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.current || this.pending.length === 0) return;
    this.pumping = true;
    try {
      const turn = this.pending.shift()!;
      this.clearIdleTimer();
      const changed = this.proc ? this.proc.key !== turn.request.key || await this.transcriptSnapshot.changedOutside(turn) : false;
      this.transcriptSnapshot.invalidate();
      if (changed) {
        this.closeProcess("Claude session settings or transcript changed; resuming in a new process");
      }
      this.current = turn;
      const resumed = this.transcriptExists;
      if (!this.proc) {
        this.startProcess(turn);
        setTimeout(turn.accepted, ACCEPT_WAIT_MS).unref?.();
      } else turn.accepted();
      turn.proc = this.proc;
      this.host.sessionStarted(this.sessionId, resumed, turn.request.onEvent);
      turn.callback = turn.request.canUseTool?.(() => sessionRef(turn.state));
      this.proc!.input.push(userMessage(turn.request.id, this.sessionId, turn.request.prompt));
      turn.timer = setTimeout(() => this.timeout(turn), Math.max(1, turn.request.timeoutMs));
    } finally {
      this.pumping = false;
    }
  }

  private startProcess(turn: Turn): void {
    const input = createInputQueue();
    const abort = new AbortController();
    const options: ClaudeSdkOptions = { ...turn.request.options, abortController: abort };
    if (this.transcriptExists) {
      options.resume = this.sessionId;
      delete options.sessionId;
      // 续跑沿用会话里已保存的标题。
      delete options.title;
    } else {
      options.sessionId = this.sessionId;
      delete options.resume;
    }
    options.env = { ...options.env, [CLAUDE_SESSION_STATE_EVENTS_ENV]: "1" };
    if (turn.request.canUseTool) {
      options.canUseTool = async (toolName, toolInput, toolOptions) => {
        const callback = this.current?.callback;
        if (!callback) return { behavior: "deny", message: "Claude tool use arrived outside an active Xuanwu turn", interrupt: true, toolUseID: toolOptions.toolUseID };
        return await callback(toolName, toolInput, toolOptions);
      };
    }
    const query = this.host.startQuery(input.iterable, options);
    const proc: LiveProcess = { abort, input, key: turn.request.key, query, stateEvents: false };
    this.proc = proc;
    void this.read(proc);
  }

  private async read(proc: LiveProcess): Promise<void> {
    let failure = "";
    try {
      for await (const message of proc.query) {
        if (this.proc !== proc) break;
        if (this.current?.proc === proc) {
          this.current.answered = true;
          this.current.accepted();
        }
        this.handle(proc, message);
      }
    } catch (error) {
      failure = redactSensitiveText(error instanceof Error ? error.message : String(error));
    }
    this.processEnded(proc, failure);
  }

  private handle(proc: LiveProcess, message: unknown): void {
    const record = objectValue(message);
    const type = cleanString(record.type);
    const subtype = cleanString(record.subtype);
    if (type === "system" && subtype === "session_state_changed") {
      proc.stateEvents = true;
      if (cleanString(record.state) === "idle" && this.current?.resultSeen) this.finish(this.current);
      return;
    }
    const turn = this.current;
    if (!turn) {
      for (const event of projectClaudeSdkMessage(message, scratchState(this.sessionId))) this.host.emit(event);
      return;
    }
    // steer 未赶上工具边界时，CLI 会在本轮 result 之后自起一轮续轮；先前扣住的 result 降级为进度。
    if (turn.heldResult && (type === "assistant" || type === "stream_event" || (type === "system" && subtype === "init"))) {
      this.emitAll(turn, turn.heldResult.map(asProgress));
      turn.heldResult = undefined;
    }
    const events = projectClaudeSdkMessage(message, turn.state);
    if (turn.state.sessionId !== this.sessionId) {
      this.fail(turn, `Claude session ${this.sessionId} returned mismatched runtime ${turn.state.sessionId}`);
      this.closeProcess("mismatched Claude session");
      return;
    }
    if (type === "system" && subtype === "init") this.transcriptExists = true;
    if (type !== "result") {
      this.emitAll(turn, events);
      return;
    }
    turn.resultSeen = true;
    turn.heldResult = events;
    if (!proc.stateEvents || turn.interrupted || turn.timedOut) this.finish(turn);
  }

  private finish(turn: Turn): void {
    if (this.current !== turn) return;
    const held = turn.heldResult ?? [];
    turn.heldResult = undefined;
    if (turn.interrupted || turn.timedOut) {
      this.emitAll(turn, held.map(asProgress));
      if (turn.timedOut) this.settle(turn, timedOutClaudeSdkEvent(turn.state, turn.timedOut), new Error(turn.timedOut));
      else this.settle(turn, interruptedClaudeSdkEvent(turn.state, turn.interrupted), new ProviderInterruptedError(turn.interrupted!));
      return;
    }
    this.emitAll(turn, held);
    if (!turn.state.terminal) return this.settle(turn, undefined, new Error("Claude SDK query ended without a terminal result event"));
    if (!turn.state.completed) return this.settle(turn, undefined, new Error("Claude SDK query failed"));
    const session = sessionRef(turn.state)!;
    this.settle(turn, undefined, undefined, {
      runId: `sdk:claude:${session.sessionId}:${session.turnId || "unknown"}`,
      session
    });
  }

  private fail(turn: Turn, message: string): void {
    this.settle(turn, undefined, new Error(message));
  }

  private settle(turn: Turn, event: ProviderEvent | undefined, error?: Error, result?: ProviderRunResult): void {
    if (this.current !== turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    if (event) this.emitAll(turn, [event]);
    turn.request.rejectApprovals("Claude invocation ended while approval was pending");
    this.current = undefined;
    if (error) turn.reject(error);
    else turn.resolve(result!);
    if (this.pending.length > 0) void this.pump();
    else this.becameIdle(cleanString(turn.request.options.cwd));
  }

  private timeout(turn: Turn): void {
    if (this.current !== turn) return;
    turn.timedOut = `Claude SDK query timed out after ${turn.request.timeoutMs}ms`;
    void this.proc?.query.interrupt?.().catch(() => undefined);
    this.closeProcess(turn.timedOut);
  }

  private processEnded(proc: LiveProcess, failure: string): void {
    if (this.proc === proc) this.proc = undefined;
    proc.input.close();
    if (!proc.abort.signal.aborted) proc.abort.abort("Claude process exited");
    try {
      proc.query.close?.();
    } catch {
      // 已退出的进程重复 close 无害。
    }
    const turn = this.current;
    if (turn && turn.proc === proc && !turn.answered && !turn.redispatched && !turn.interrupted && !turn.timedOut && this.transcriptExists) {
      // 常驻进程在两轮之间退出（崩溃、被外部结束）时，刚派发的消息没被处理过，换新进程 resume 后重发一次。
      if (turn.timer) clearTimeout(turn.timer);
      turn.redispatched = true;
      turn.proc = undefined;
      this.current = undefined;
      this.pending.unshift(turn);
    } else if (turn && turn.proc === proc) {
      if (turn.resultSeen && !turn.interrupted && !turn.timedOut) this.finish(turn);
      else if (turn.interrupted || turn.timedOut) this.finish(turn);
      else this.fail(turn, failure || "Claude SDK query ended without a terminal result event");
    }
    if (!this.current && this.pending.length > 0) void this.pump();
    this.releaseIfDone();
  }

  private closeProcess(reason: string): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.clearIdleTimer();
    proc.input.close();
    if (!proc.abort.signal.aborted) proc.abort.abort(reason);
    try {
      proc.query.close?.();
    } catch {
      // 进程已退出时 close 可能抛错；读循环会负责收尾当前轮。
    }
    // 读循环可能还卡在等待下一条消息；兜底收尾，避免当前轮永远悬挂。
    if (this.current?.proc === proc) queueMicrotask(() => this.processEnded(proc, reason));
  }

  private becameIdle(cwd: string): void {
    this.clearIdleTimer();
    void this.transcriptSnapshot.capture(cwd);
    if (!this.proc) {
      this.releaseIfDone();
      return;
    }
    this.idleTimer = setTimeout(() => this.closeProcess("Claude process idle timeout"), Math.max(1, this.host.idleTimeoutMs));
    this.idleTimer.unref?.();
  }

  private releaseIfDone(): void {
    if (!this.proc && !this.current && this.pending.length === 0) this.host.released(this);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private emitAll(turn: Turn, events: ProviderEvent[]): void {
    for (const event of events) this.host.emit(event, turn.request.onEvent);
  }
}

export { CLAUDE_SESSION_STATE_EVENTS_ENV, type ClaudeLiveQuery, type ClaudeLiveTurnRequest, type ClaudeLiveSessionHost, type ClaudeLiveSubmission } from "./liveSessionModel.ts";
