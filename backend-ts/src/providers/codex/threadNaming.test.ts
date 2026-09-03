import { describe, expect, test } from "bun:test";
import { CodexThreadNaming, type CodexThreadTitleInput } from "./threadNaming.ts";
import type { ThreadSummary } from "./threadLifecycle.ts";

const input: CodexThreadTitleInput = {
  thread: {
    id: "codex:t1", provider_session_id: "t1", sessionId: "t1", provider: "codex", ephemeral: false,
    createdAt: Date.parse("2026-09-02T16:00:00Z") / 1000, updatedAt: Date.parse("2026-09-10T00:00:00Z") / 1000,
    name: "Issue #913", cwd: "/tmp/demo", isPinned: true, archived: false
  },
  prompt: "修复消息重复", issueId: 913, projectId: "demo"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function adapter() {
  const value = structuredClone(input.thread);
  const writes: unknown[] = [];
  return {
    value, writes,
    async readThread(_id: string, options: { includeTurns: boolean }): Promise<ThreadSummary> {
      expect(options).toEqual({ includeTurns: false });
      return { ...value };
    },
    async setThreadName(id: string, name: string) { writes.push({ id, name }); value.name = name; }
  };
}

describe("Codex 后台标题生成", () => {
  test("不等待 LLM，去重，并且只更新名称", async () => {
    const rpc = adapter();
    const completion = deferred<string | null>();
    const finished = deferred<void>();
    let calls = 0;
    const naming = new CodexThreadNaming(rpc, {
      generate: async () => { calls++; return completion.promise; },
      acquire: () => ({ release: () => finished.resolve() })
    });
    naming.schedule(input);
    naming.schedule(input);
    expect(calls).toBe(1);
    expect(rpc.writes).toEqual([]);
    completion.resolve("0903｜修复｜消息重复");
    await finished.promise;
    expect(rpc.writes).toEqual([{ id: "t1", name: "0903｜修复｜消息重复" }]);
    expect(rpc.value).toEqual({ ...input.thread, name: "0903｜修复｜消息重复" });
    naming.schedule(input);
    expect(calls).toBe(1);
  });

  test("用户在生成期间改名时保留用户标题", async () => {
    const rpc = adapter();
    const completion = deferred<string | null>();
    const finished = deferred<void>();
    const naming = new CodexThreadNaming(rpc, {
      generate: () => completion.promise, acquire: () => ({ release: () => finished.resolve() })
    });
    naming.schedule(input);
    rpc.value.name = "我的标题";
    completion.resolve("0903｜修复｜消息重复");
    await finished.promise;
    expect(rpc.writes).toEqual([]);
    expect(rpc.value.name).toBe("我的标题");
  });

  test("空内容等待首次消息，null 保留原名", async () => {
    const rpc = adapter();
    const finished = deferred<void>();
    let calls = 0;
    const naming = new CodexThreadNaming(rpc, {
      generate: async () => { calls++; return null; }, acquire: () => ({ release: () => finished.resolve() })
    });
    naming.schedule({ ...input, prompt: " " });
    expect(calls).toBe(0);
    naming.schedule(input);
    await finished.promise;
    expect(calls).toBe(1);
    expect(rpc.writes).toEqual([]);
  });

  test.each(["timeout", "stop", "rename"])("%s 取消后不允许迟到结果改名，并释放 lease", async (reason) => {
    const rpc = adapter();
    const completion = deferred<string | null>();
    const finished = deferred<void>();
    let signal!: AbortSignal;
    let notify!: Parameters<NonNullable<ConstructorParameters<typeof CodexThreadNaming>[1]["subscribe"]>>[0];
    let unsubscribed = false;
    const naming = new CodexThreadNaming(rpc, {
      generate: async (_input, value) => { signal = value; return completion.promise; },
      timeoutMs: 5,
      acquire: () => ({ release: () => finished.resolve() }),
      subscribe: (handler) => { notify = handler; return () => { unsubscribed = true; }; }
    });
    naming.schedule(input);
    if (reason === "stop") naming.stop();
    if (reason === "rename") notify({ raw: { method: "thread/name/updated", payload: '{"threadName":"用户改名"}' }, session: { sessionId: "t1" } });
    await finished.promise;
    expect(signal.aborted).toBe(true);
    expect(unsubscribed).toBe(true);
    completion.resolve("0903｜修复｜消息重复");
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc.writes).toEqual([]);
  });

  test("忽略默认名的迟到通知", async () => {
    const rpc = adapter();
    const completion = deferred<string | null>();
    const finished = deferred<void>();
    let notify!: Parameters<NonNullable<ConstructorParameters<typeof CodexThreadNaming>[1]["subscribe"]>>[0];
    const naming = new CodexThreadNaming(rpc, {
      generate: () => completion.promise,
      acquire: () => ({ release: () => finished.resolve() }),
      subscribe: (handler) => { notify = handler; return () => {}; }
    });
    naming.schedule(input);
    notify({ raw: { method: "thread/name/updated", payload: '{"threadName":"Issue #913"}' }, session: { sessionId: "t1" } });
    completion.resolve("0903｜修复｜消息重复");
    await finished.promise;
    expect(rpc.writes).toHaveLength(1);
  });
});
