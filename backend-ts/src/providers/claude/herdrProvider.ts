import { statSync } from "node:fs";
import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString } from "../../util/values.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { ProviderInterruptedError, type ExecutorProvider, type ProviderEvent, type ProviderRunInput, type ProviderRecoveryInput, type SessionCreateInput, type SessionMessageInput, type SessionListInput, type SessionReadInput, type InterruptInput, type ApprovalDecision, type ProviderRuntimeStatus } from "../types.ts";
import { ClaudePermissionBroker } from "./permissionBroker.ts";
import { publicClaudeSessionDetail, publicClaudeSessionSummary, readBoundedClaudeSessionHistory } from "./sessionHistory.ts";
import { HerdrHooks, type HookBody } from "./herdrHooks.ts";
import { inspectHerdr, herdrRequest, shellQuote, type HerdrProbe, type HerdrRpc } from "./herdrTransport.ts";

type Turn = {
  id: string; started: boolean; stopSeen: boolean; lastMessage: string;
  done: Promise<void>; resolve: () => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; onEvent?: (event: ProviderEvent) => void;
};
type Terminal = {
  id: string; pane: string; cwd: string; hooks: HerdrHooks; ready: boolean;
  policy: NonNullable<SessionCreateInput["policy"]>; model: string;
  turn?: Turn; controller: AbortController; monitor?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};
type Options = { eventSink?: (event: ProviderEvent) => void; probe?: () => HerdrProbe; rpc?: HerdrRpc; pollMs?: number };

/** 原生 TUI：herdr 拥有 PTY，玄武只控制自己创建的 pane。
 * SDK 只用于读取原生历史，不执行 query；不发送 -p/stream-json，不解析 ANSI 判断成功。
 */
export class ClaudeHerdrProvider implements ExecutorProvider {
  readonly id = "claude" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals"] as const;
  readonly interruptScope = "session" as const;
  private readonly terminals = new Map<string, Terminal>();
  private readonly reservations = new Set<string>();
  private readonly broker = new ClaudePermissionBroker();
  private probe: HerdrProbe;
  private readonly rpc: HerdrRpc;
  private stopped = false;

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: Options = {}) {
    this.probe = (options.probe ?? (() => inspectHerdr(config)))();
    this.rpc = options.rpc ?? ((method, params) => herdrRequest(this.probe.socket, method, params));
  }

  runtimeStatus(): ProviderRuntimeStatus {
    if (!this.stopped && this.terminals.size === 0) this.probe = (this.options.probe ?? (() => inspectHerdr(this.config)))();
    return { ready: this.probe.ready && !this.stopped, reason: this.probe.reason, version: this.probe.version,
      mode: "herdr", active_sessions: this.terminals.size, api_key_configured: false,
      auth_mode: "local-cli", auth_source: "local_cli", auth_configured: this.probe.ready, executable_ready: this.probe.ready };
  }

  async run(input: ProviderRunInput) {
    if (input.images?.length) throw new Error("herdr 模式请在原生终端添加附件，当前 API 不支持图片输入");
    const { terminal, turn } = await this.launch(input, "", input.onEvent);
    await turn.done;
    return { runId: `herdr:${terminal.id}:${turn.id}`, session: { provider: this.id, sessionId: terminal.id, turnId: turn.id } };
  }

  async recover(input: ProviderRecoveryInput) {
    if (input.images?.length) throw new Error("herdr 模式请在原生终端添加附件，当前 API 不支持图片输入");
    const { terminal, turn } = await this.submit({ ...input, sessionId: input.session.sessionId }, input.onEvent);
    await turn.done;
    return { runId: `herdr:${terminal.id}:${turn.id}`, session: { provider: this.id, sessionId: terminal.id, turnId: turn.id } };
  }

  async createSession(input: SessionCreateInput) {
    const { terminal, turn } = await this.launch(input);
    return { id: `claude:${terminal.id}`, provider: this.id, provider_session_id: terminal.id, thread_id: terminal.id, provider_turn_id: turn.id, turn_id: turn.id };
  }

  async sendSessionMessage(input: SessionMessageInput) {
    const { terminal, turn } = await this.submit(input);
    return { provider: this.id, provider_session_id: terminal.id, sessionId: terminal.id, turn_id: turn.id };
  }

  async listSessions(input: SessionListInput = {}) {
    const offset = Number(input.cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Claude history cursor");
    const limit = Math.max(1, Math.min(100, input.limit || 30));
    const sessions = await listSessions({ ...(input.cwd ? { dir: input.cwd } : {}), offset, limit });
    return { data: sessions.map((s) => publicClaudeSessionSummary(s, !!this.terminals.get(s.sessionId)?.turn)), nextCursor: sessions.length === limit ? String(offset + limit) : "" };
  }

  async readSession(id: string, input: SessionReadInput = {}) {
    const info = await getSessionInfo(id);
    if (!info && !this.terminals.has(id)) throw new Error("Claude session not found");
    const messages = input.includeTurns === false ? [] : await readBoundedClaudeSessionHistory(id, info, getSessionMessages);
    const terminal = this.terminals.get(id);
    return { ...publicClaudeSessionDetail(id, info, messages, !!terminal?.turn),
      native_terminal: { mode: "herdr", ...(terminal ? { pane_id: terminal.pane, instruction: "打开 herdr 中对应 pane 可操作同一个 Claude 终端；不要同时另起 resume 进程。" } : {}) } };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const terminal = this.terminals.get(input.session.sessionId);
    if (!terminal?.turn) throw new Error("Claude herdr session is not running");
    await this.assertOwner(terminal);
    await this.rpc("agent.send_keys", { target: terminal.pane, keys: ["esc"] });
    this.finish(terminal, new ProviderInterruptedError(input.reason || "Claude terminal interrupted"));
    // Esc 没有结构化取消确认；关闭本任务的 pane，后续 resume，避免把迟到 Stop 归到下一轮。
    await this.close(terminal);
  }

  resolveApproval(id: string, decision: ApprovalDecision) { return this.broker.resolveApproval(id, decision); }

  async stop(): Promise<void> {
    this.stopped = true;
    this.broker.rejectAll("Claude herdr provider stopped");
    await Promise.all([...this.terminals.values()].map(async (terminal) => {
      this.finish(terminal, new ProviderInterruptedError("Claude herdr provider stopped"));
      await this.close(terminal);
    }));
  }

  private validate(input: SessionCreateInput): void {
    if (this.stopped || !this.probe.ready) throw new Error(this.probe.reason || "Claude herdr provider stopped");
    if (!input.policy) throw new Error("Claude herdr requires a resolved execution policy");
    if (!input.cwd || !statSync(input.cwd).isDirectory()) throw new Error("Claude working directory is unavailable");
    const prompt = cleanString(input.prompt);
    if (!prompt || prompt.startsWith("/") || /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt)) throw new Error("Provide a text prompt without terminal control characters or slash commands; use the native terminal for commands");
    if (Buffer.byteLength(prompt) > 128 * 1024) throw new Error("Claude terminal prompt exceeds 128 KiB");
  }

  private async launch(input: SessionCreateInput, resume = "", onEvent?: (event: ProviderEvent) => void) {
    this.validate(input);
    const id = resume || crypto.randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude session ID");
    if (this.reservations.has(id) || this.terminals.has(id)) throw new Error("Claude herdr session is already owned");
    this.reservations.add(id);
    let terminal: Terminal | undefined;
    let hooks: HerdrHooks | undefined;
    try {
      // 已有 herdr 原生会话不得重复 resume，避免同一历史的双写。
      if (resume) {
        const agents = await this.rpc("agent.list", {});
        if (!Array.isArray(agents.agents)) throw new Error("Cannot verify existing herdr sessions");
        if (agents.agents.some((a: any) => a.agent_session?.value === id)) throw new Error("Session is already open in herdr; continue in its terminal");
      }
      hooks = new HerdrHooks(this.probe.curl, id, (body) => terminal ? this.hook(terminal, body) : Promise.resolve({}));
      const created = await this.rpc("workspace.create", { cwd: input.cwd, label: `玄武 Claude ${id.slice(0, 8)}`, focus: false,
        env: { ...this.config.env, HOME: Bun.env.HOME || "", PATH: Bun.env.PATH || "", XUANWU_MANAGED_EXECUTION: "1" } });
      const pane = created.root_pane?.pane_id;
      if (typeof pane !== "string" || !pane) throw new Error("herdr did not return a root pane");
      terminal = { id, pane, cwd: input.cwd, hooks, ready: false, policy: input.policy!, model: cleanString(input.model) || cleanString(this.config.model), controller: new AbortController() };
      this.terminals.set(id, terminal);
      if (this.stopped) throw new Error("Claude startup cancelled");
      const turn = this.newTurn(terminal, onEvent);
      const args = [this.probe.claude, resume ? "--resume" : "--session-id", id, "--settings", hooks.settings];
      if (terminal.model) args.push("--model", terminal.model);
      if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
      // 不启用 bypass、不改变用户的 skills/MCP/settings；工具调用仍经过本次临时 PreToolUse gate。
      const configDir = Bun.env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shellQuote(Bun.env.CLAUDE_CONFIG_DIR)} ` : "";
      await this.rpc("pane.send_input", { pane_id: pane, text: "env -u CLAUDECODE -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CONFIG_DIR " + configDir + args.map(shellQuote).join(" "), keys: ["Enter"] });
      const deadline = Date.now() + Math.min(30_000, this.config.timeoutMs);
      while (!terminal.ready && terminal.turn === turn && !this.stopped && Date.now() < deadline) await Bun.sleep(50);
      if (terminal.turn !== turn || this.stopped) throw new Error("Claude startup cancelled");
      if (!terminal.ready) throw new Error("Claude 启动 hook 未就绪，请在 herdr 终端检查登录、目录信任和 hooks 设置；未发送任务");
      // SessionStart 在后台触发，比输入框就绪早；等待 herdr 明确确认交互可用。
      while (true) {
        if (!terminal.turn || this.stopped) throw new Error("Claude startup cancelled");
        const agent = await this.assertOwner(terminal);
        if (agent.interactive_ready && ["idle", "done"].includes(agent.agent_status)) break;
        if (Date.now() >= deadline) throw new Error("Claude 终端未就绪，请在 herdr 检查登录、目录信任或确认框；未发送任务");
        await Bun.sleep(100);
      }
      await this.rpc("agent.prompt", { target: pane, text: input.prompt });
      this.monitor(terminal);
      return { terminal, turn };
    } catch (error) {
      if (terminal) { this.finish(terminal, error as Error); await this.close(terminal); }
      else hooks?.dispose();
      throw error;
    } finally { this.reservations.delete(id); }
  }

  private async submit(input: SessionMessageInput, onEvent?: (event: ProviderEvent) => void) {
    // 当前只保证原生终端输入，尚未验收运行中输入的消费时机，不把它宣称为 live steer。
    if (input.mode === "steer") throw new Error("herdr live steer 尚未验证；请在原生终端操作或等待当前轮结束");
    const terminal = this.terminals.get(input.sessionId);
    const info = terminal ? undefined : await getSessionInfo(input.sessionId);
    const cwd = input.cwd || terminal?.cwd || info?.cwd || "";
    this.validate({ ...input, cwd });
    if (!terminal) return this.launch({ ...input, cwd }, input.sessionId, onEvent);
    if (terminal.turn) throw new Error("Claude terminal is busy; wait for the current turn");
    if (cwd !== terminal.cwd || JSON.stringify(input.policy?.requested) !== JSON.stringify(terminal.policy.requested) || (input.model && input.model !== terminal.model)) throw new Error("Close the native session before changing its cwd, model or execution policy");
    // 先占位再 await，防止两个 HTTP 请求同时向同一个终端输入。
    const turn = this.newTurn(terminal, onEvent);
    try {
      await this.assertOwner(terminal);
      await this.rpc("agent.prompt", { target: terminal.pane, text: input.prompt });
      this.monitor(terminal);
      return { terminal, turn };
    } catch (error) { this.finish(terminal, error as Error); await this.close(terminal); throw error; }
  }

  private newTurn(terminal: Terminal, onEvent?: (event: ProviderEvent) => void): Turn {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // 会话 API 入队即返回，后台失败通过事件交付，避免未订阅 Promise 拒绝。
    void done.catch(() => {});
    const timer = setTimeout(() => {
      this.finish(terminal, new Error("Claude herdr turn timed out; inspect terminal/history"));
      void this.close(terminal).catch(() => {});
    }, this.config.timeoutMs);
    const turn = { id: crypto.randomUUID(), started: false, stopSeen: false, lastMessage: "", done, resolve, reject, timer, onEvent };
    terminal.turn = turn;
    return turn;
  }

  private async hook(terminal: Terminal, body: HookBody): Promise<Record<string, unknown>> {
    const event = body.hook_event_name;
    if (event === "SessionStart") {
      await this.rpc("pane.report_agent_session", { pane_id: terminal.pane, source: "herdr:claude", agent: "claude", agent_session_id: terminal.id });
      terminal.ready = true;
    } else if (event === "UserPromptSubmit") {
      if (!terminal.turn) this.newTurn(terminal); // 人在同一个 pane 输入也进入统一生命周期。
      terminal.turn!.started = true;
      terminal.turn!.stopSeen = false;
      this.emit(terminal, providerSessionStartedEvent("claude", terminal.id, { method: "herdr/UserPromptSubmit", turnId: terminal.turn!.id }));
      this.monitor(terminal);
    } else if (event === "PreToolUse") {
      if (terminal.turn) terminal.turn.stopSeen = false;
      // 提问本身没有文件/命令副作用，交给真实 TUI 展示选项并接受用户回答。
      if (body.tool_name === "AskUserQuestion") return {};
      const result = await this.broker.callback({ cwd: terminal.cwd, invocationRef: terminal.id, policy: terminal.policy, session: () => this.ref(terminal), onEvent: (e) => this.emit(terminal, e) })(
        cleanString(body.tool_name), body.tool_input || {}, { signal: terminal.controller.signal, toolUseID: cleanString(body.tool_use_id), requestId: crypto.randomUUID() }
      );
      this.emit(terminal, { provider: this.id, type: "tool", session: this.ref(terminal), text: cleanString(body.tool_name) });
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result?.behavior === "allow" ? "allow" : "deny", permissionDecisionReason: result?.behavior === "deny" ? result.message : result?.behavior === "allow" ? "玄武执行策略已批准" : "无法确认执行策略" } };
    } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
      this.emit(terminal, { provider: this.id, type: "tool_result", session: this.ref(terminal), text: redactSensitiveText(JSON.stringify(body.tool_response ?? body.error ?? "")).slice(0, 64 * 1024) });
    } else if (event === "PermissionRequest") {
      this.emit(terminal, { provider: this.id, type: "text", session: this.ref(terminal), text: "Claude 原生终端正在等待确认，请打开 herdr 对应 pane 处理。" });
    } else if (event === "Stop" && terminal.turn?.started) {
      terminal.turn.stopSeen = true;
      terminal.turn.lastMessage = cleanString(body.last_assistant_message);
    } else if (event === "SessionEnd") {
      this.finish(terminal, new Error("Claude terminal exited"));
      terminal.ready = false;
      // 已退出的终端保留给人查看，不能关闭可能已启动其他命令的 shell。
      this.terminals.delete(terminal.id);
      setTimeout(() => terminal.hooks.dispose(), 0);
    }
    return {};
  }

  private monitor(terminal: Terminal): void {
    if (terminal.monitor || !terminal.turn) return;
    terminal.monitor = setTimeout(async () => {
      terminal.monitor = undefined;
      if (!terminal.turn || !this.terminals.has(terminal.id)) return;
      try {
        const agent = await this.assertOwner(terminal);
        // Stop 可能被用户的其他 hooks 阻止；同时确认终端已回到 idle/done。
        // 仅屏幕空闲、RPC 入队成功或进程退出都不能作为成功证据。
        if (terminal.turn?.stopSeen && ["idle", "done"].includes(agent.agent_status)) this.finish(terminal);
        else this.monitor(terminal);
      } catch (error) { this.finish(terminal, error as Error); await this.close(terminal); }
    }, this.options.pollMs ?? 1000);
  }

  private async assertOwner(terminal: Terminal) {
    const result = await this.rpc("agent.get", { target: terminal.pane });
    const agent = result.agent;
    if (!agent || agent.agent_session?.value !== terminal.id) throw new Error("herdr pane owner changed or Claude exited; no input sent");
    return agent;
  }

  private finish(terminal: Terminal, error?: Error): void {
    const turn = terminal.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    if (terminal.monitor) clearTimeout(terminal.monitor);
    terminal.monitor = undefined;
    this.broker.rejectInvocation(terminal.id, "Claude turn ended");
    if (turn.lastMessage) this.emit(terminal, { provider: this.id, type: "text", session: this.ref(terminal), text: redactSensitiveText(turn.lastMessage) });
    const outcome = error ? error instanceof ProviderInterruptedError ? "interrupted" : "failed" : "succeeded";
    this.emit(terminal, { provider: this.id, type: error ? "error" : "done", session: this.ref(terminal), error: error ? redactSensitiveText(error.message) : undefined,
      runEvent: normalizedRunEvent({ provider: this.id, method: "herdr/turn_end", kind: error ? "error" : "completed", outcome, session: this.ref(terminal), terminal: true }) });
    terminal.turn = undefined;
    if (error) turn.reject(error); else turn.resolve();
  }

  private async close(terminal: Terminal): Promise<void> {
    if (terminal.closing) return terminal.closing;
    terminal.closing = (async () => {
      terminal.controller.abort();
      try {
        // 启动尚未确认或 owner 已换时留下 pane 给用户检查，不能猜测进程归属。
        await this.assertOwner(terminal);
        await this.rpc("pane.close", { pane_id: terminal.pane });
      } catch {
        this.emit(terminal, { provider: this.id, type: "text", session: this.ref(terminal), text: `未能确认关闭 herdr pane ${terminal.pane}，请在原生终端检查；玄武 hooks 已停用并拒绝后续工具执行。` });
      } finally {
        this.terminals.delete(terminal.id);
        terminal.hooks.dispose();
      }
    })();
    return terminal.closing;
  }

  private ref(terminal: Terminal) { return { provider: this.id, sessionId: terminal.id, turnId: terminal.turn?.id }; }
  private emit(terminal: Terminal, event: ProviderEvent) {
    const method = event.raw?.method || `herdr/${event.type}`;
    (terminal.turn?.onEvent ?? this.options.eventSink)?.({
      ...event,
      raw: event.raw ?? { method },
      runEvent: event.runEvent ?? normalizedRunEvent({ provider: this.id, method, kind: "progress", outcome: "running", session: event.session })
    });
  }
}
