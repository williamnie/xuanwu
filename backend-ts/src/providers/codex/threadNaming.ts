import type { ThreadSummary } from "./threadLifecycle.ts";

export type CodexThreadTitleInput = {
  thread: ThreadSummary;
  prompt: string;
  issueId?: number;
  projectId?: string;
  cwd?: string;
};
export type CodexThreadTitleGenerator = (input: CodexThreadTitleInput, signal: AbortSignal) => Promise<string | null>;

type NamingAdapter = {
  readThread(id: string, options: { includeTurns: boolean }): Promise<ThreadSummary>;
  setThreadName(id: string, name: string): Promise<unknown>;
};
type NamingOptions = {
  generate?: CodexThreadTitleGenerator;
  acquire: (owner: string) => { release(): void };
  subscribe?: (handler: (event: { raw?: { method?: string; payload?: unknown }; session?: { sessionId?: string } }) => void) => () => void;
  timeoutMs?: number;
};

/** 标题任务独立于执行 turn；仅对未命名或本次设置的默认标题尝试一次。 */
export class CodexThreadNaming {
  private readonly attempted = new Set<string>();
  private readonly pending = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly adapter: NamingAdapter, private readonly options: NamingOptions) {}

  schedule(input: CodexThreadTitleInput): void {
    const id = input.thread.provider_session_id;
    if (!this.options.generate || this.stopped || !id || !input.prompt.trim() || this.attempted.has(id) || this.pending.has(id)) return;
    input = { ...input, thread: { ...input.thread } };
    this.attempted.add(id);
    // 仅作进程内去重；已生成的名称由 Codex 持久化，恢复时不会再次生成。
    if (this.attempted.size > 2048) this.attempted.delete(this.attempted.values().next().value!);
    const controller = new AbortController();
    this.pending.set(id, controller);
    // 不绑定执行 turn，避免 turn/completed 提前释放标题任务的 lease。
    const lease = this.options.acquire(`thread:${id}:title`);
    const unsubscribe = this.options.subscribe?.((event) => {
      if (event.raw?.method !== "thread/name/updated" || event.session?.sessionId !== id) return;
      // 忽略设置默认名时可能晚于 RPC 响应到达的通知。
      try {
        const payload = typeof event.raw.payload === "string" ? JSON.parse(event.raw.payload) : event.raw.payload;
        if (payload?.threadName === input.thread.name) return;
      } catch { /* 无法确认的改名通知按用户改名处理。 */ }
      controller.abort();
    });
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    const signal = controller.signal;
    let onAbort = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    void Promise.race([this.rename(input, signal), aborted])
      .catch(() => {
        // 不记录模型输出或供应商错误，避免标题任务的日志包含正文或凭据。
        if (!signal.aborted) console.warn(JSON.stringify({ event: "codex.thread_title_failed", thread_id: id }));
      })
      .finally(() => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        lease.release();
        this.pending.delete(id);
      });
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.pending.values()) controller.abort();
  }

  private async rename(input: CodexThreadTitleInput, signal: AbortSignal): Promise<void> {
    const name = await this.options.generate!(input, signal);
    if (signal.aborted || !name) return;
    const id = input.thread.provider_session_id;
    const latest = await this.adapter.readThread(id, { includeTurns: false });
    if (signal.aborted || (latest.name ?? "") !== (input.thread.name ?? "")) return;
    // 只写 name，不更新线程其他元数据；用户在生成期间改名则保留用户的名称。
    await this.adapter.setThreadName(id, name);
  }
}
