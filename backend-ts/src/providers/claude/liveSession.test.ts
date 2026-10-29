import { describe, expect, test } from "bun:test";
import { ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import { CLAUDE_SESSION_STATE_EVENTS_ENV } from "./liveSession.ts";
import type { ProviderEvent } from "../types.ts";

const cwd = import.meta.dir;
const SESSION = "live-session";

describe("Claude persistent SDK session", () => {
  test("keeps one process across turns and returns message submission before the turn finishes", async () => {
    const cli = fakeCli();
    const provider = liveProvider(cli);

    const run = provider.run(runInput());
    const first = await cli.waitProcess(0);
    expect(first.options.sessionId).toBe(SESSION);
    expect(first.options.env?.[CLAUDE_SESSION_STATE_EVENTS_ENV]).toBe("1");
    await waitFor(() => first.inputs.length === 1);
    completeTurn(first, "r1");
    expect((await run).session?.sessionId).toBe(SESSION);

    const message = await provider.sendSessionMessage({ cwd, prompt: "next", sessionId: SESSION });
    await waitFor(() => first.inputs.length === 2);
    expect(message.turn_id).toBe(first.inputs[1]!.uuid);
    expect(provider.runtimeStatus().active_sessions).toBe(1);
    expect(cli.processes).toHaveLength(1);
    completeTurn(first, "r2");
    await waitFor(() => provider.runtimeStatus().active_sessions === 0);
    expect(cli.processes).toHaveLength(1);
  });

  test("steer writes priority next into the running turn and is refused when idle", async () => {
    const cli = fakeCli();
    const provider = liveProvider(cli);
    const run = provider.run(runInput());
    const proc = await cli.waitProcess(0);
    await waitFor(() => proc.inputs.length === 1);
    proc.emit(init("i1"));

    const steered = await provider.sendSessionMessage({ cwd, mode: "steer", prompt: "also this", sessionId: SESSION });
    expect(steered.turn_id).toBe(proc.inputs[0]!.uuid);
    await waitFor(() => proc.inputs.length === 2);
    expect(proc.inputs[1]).toMatchObject({ priority: "next", message: { content: "also this" } });

    completeTurn(proc, "r1");
    await run;
    await expect(provider.sendSessionMessage({ cwd, mode: "steer", prompt: "late", sessionId: SESSION }))
      .rejects.toThrow("没有可引导的运行中 turn");
  });

  test("a result followed by a steer-spawned follow-up is not terminal until the CLI reports idle", async () => {
    const cli = fakeCli();
    const events: ProviderEvent[] = [];
    const provider = liveProvider(cli);
    let settled = false;
    const run = provider.run(runInput((event) => events.push(event))).finally(() => { settled = true; });
    const proc = await cli.waitProcess(0);
    proc.emit(state("running"));
    proc.emit(init("i1"));
    proc.emit(success("r1", "first"));
    proc.emit(init("i2"));
    proc.emit(success("r2", "second"));
    await Bun.sleep(5);
    expect(settled).toBe(false);
    proc.emit(state("idle"));
    expect((await run).session?.turnId).toBe("r2");

    const terminal = events.filter((event) => event.runEvent?.terminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "done", text: "second" });
    expect(events.find((event) => event.status === "superseded")).toMatchObject({
      runEvent: { kind: "progress", terminal: false, cost: expect.anything() }
    });
  });

  test("queues concurrent messages locally so the CLI never merges them into one turn", async () => {
    const cli = fakeCli();
    // 玄武自己的轮会持续改写 transcript；连续派发排队消息不能被误判成“终端改过”而换进程。
    let writes = 0;
    const provider = liveProvider(cli, {
      getSessionInfo: async () => ({ sessionId: SESSION, summary: "", lastModified: ++writes, fileSize: writes, cwd })
    });
    const run = provider.run(runInput());
    const proc = await cli.waitProcess(0);
    await waitFor(() => proc.inputs.length === 1);

    const queuedA = await provider.sendSessionMessage({ cwd, prompt: "A", sessionId: SESSION });
    const queuedB = await provider.sendSessionMessage({ cwd, prompt: "B", sessionId: SESSION });
    await Bun.sleep(5);
    expect(proc.inputs).toHaveLength(1);

    completeTurn(proc, "r1");
    await run;
    await waitFor(() => proc.inputs.length === 2);
    expect(proc.inputs[1]).toMatchObject({ uuid: queuedA.turn_id, message: { content: "A" } });
    completeTurn(proc, "r2");
    await waitFor(() => proc.inputs.length === 3);
    expect(proc.inputs[2]).toMatchObject({ uuid: queuedB.turn_id, message: { content: "B" } });
    completeTurn(proc, "r3");
    await waitFor(() => provider.runtimeStatus().active_sessions === 0);
    expect(cli.processes).toHaveLength(1);
  });

  test("interrupt stops the turn but keeps the process; interrupting an idle session releases it", async () => {
    const cli = fakeCli();
    const events: ProviderEvent[] = [];
    const provider = liveProvider(cli);
    const run = provider.run(runInput((event) => events.push(event)));
    const proc = await cli.waitProcess(0);
    await waitFor(() => proc.inputs.length === 1);
    proc.emit(init("i1"));

    await provider.interrupt({ reason: "user stop", session: { provider: "claude", sessionId: SESSION } });
    expect(proc.interrupted).toBe(1);
    proc.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SESSION, uuid: "r1" });
    await expect(run).rejects.toThrow("user stop");
    expect(events.at(-1)).toMatchObject({ status: "interrupted", runEvent: { terminal: true } });
    proc.emit(state("idle"));

    const next = provider.run(runInput());
    await waitFor(() => proc.inputs.length === 2);
    completeTurn(proc, "r2");
    await next;
    expect(cli.processes).toHaveLength(1);

    await provider.interrupt({ session: { provider: "claude", sessionId: SESSION } });
    expect(proc.closed).toBeGreaterThanOrEqual(1);
    await waitFor(() => provider.runtimeStatus().active_sessions === 0);
    const resuming = provider.sendSessionMessage({ cwd, prompt: "back", sessionId: SESSION });
    const second = await cli.waitProcess(1);
    expect(second.options.resume).toBe(SESSION);
    expect(second.options.sessionId).toBeUndefined();
    await waitFor(() => second.inputs.length === 1);
    completeTurn(second, "r3");
    expect(second.inputs[0]?.uuid).toBe((await resuming).turn_id);
  });

  test("resumes in a new process when settings change or the transcript was written elsewhere", async () => {
    const cli = fakeCli();
    let info = { sessionId: SESSION, summary: "", lastModified: 1, fileSize: 10, cwd };
    const provider = liveProvider(cli, { getSessionInfo: async () => info });
    const first = provider.run(runInput());
    const proc = await cli.waitProcess(0);
    completeTurn(proc, "r1");
    await first;
    await Bun.sleep(5);

    info = { ...info, lastModified: 2, fileSize: 20 };
    const afterTerminal = provider.run(runInput());
    const second = await cli.waitProcess(1);
    expect(proc.closed).toBeGreaterThanOrEqual(1);
    expect(second.options.resume).toBe(SESSION);
    completeTurn(second, "r2");
    await afterTerminal;
    await Bun.sleep(5);

    const otherModel = provider.run({ ...runInput(), model: "claude-other" });
    const third = await cli.waitProcess(2);
    expect(third.options.model).toBe("claude-other");
    completeTurn(third, "r3");
    await otherModel;
  });

  test("closes the idle process after the idle timeout and fails early submissions visibly", async () => {
    const cli = fakeCli();
    const provider = liveProvider(cli, {}, 5);
    const run = provider.run(runInput());
    const proc = await cli.waitProcess(0);
    completeTurn(proc, "r1");
    await run;
    await waitFor(() => proc.closed >= 1);

    const failing = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: (() => (async function* () { throw new Error("spawn failed"); })() as ClaudeQuery) as ClaudeQueryFactory,
      sessionIdFactory: () => SESSION,
      sessionFunctions: { getSessionInfo: async () => undefined }
    });
    await expect(failing.sendSessionMessage({ cwd, prompt: "hi", sessionId: SESSION })).rejects.toThrow("spawn failed");
  });
});

type FakeProcess = {
  closed: number;
  emit(message: unknown): void;
  inputs: Array<Record<string, any>>;
  interrupted: number;
  options: Record<string, any>;
};

function fakeCli() {
  const processes: FakeProcess[] = [];
  const factory = ((input) => {
    const out: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const proc: FakeProcess = {
      closed: 0,
      emit(message) { out.push(message); wake?.(); },
      inputs: [],
      interrupted: 0,
      options: input.options as Record<string, any>
    };
    void (async () => {
      for await (const message of input.prompt as AsyncIterable<Record<string, any>>) proc.inputs.push(message);
    })();
    const query = (async function* () {
      while (true) {
        if (out.length > 0) { yield out.shift(); continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })() as ClaudeQuery;
    query.close = () => { proc.closed += 1; ended = true; wake?.(); };
    query.interrupt = async () => { proc.interrupted += 1; };
    processes.push(proc);
    return query;
  }) as ClaudeQueryFactory;
  return {
    factory,
    processes,
    async waitProcess(index: number): Promise<FakeProcess> {
      await waitFor(() => processes.length > index);
      return processes[index]!;
    }
  };
}

function liveProvider(
  cli: ReturnType<typeof fakeCli>,
  sessionFunctions: Record<string, unknown> = {},
  idleTimeoutMs = 60_000
): ClaudeSdkExecutorProvider {
  return new ClaudeSdkExecutorProvider(config(), {
    idleTimeoutMs,
    queryFactory: cli.factory,
    sessionIdFactory: () => SESSION,
    sessionFunctions: { getSessionInfo: async () => undefined, ...sessionFunctions }
  });
}

function completeTurn(proc: FakeProcess, resultUuid: string): void {
  proc.emit(state("running"));
  proc.emit(init(`init-${resultUuid}`));
  proc.emit(success(resultUuid, "done"));
  proc.emit(state("idle"));
}

function config() {
  return { command: "claude", cwd, env: {}, mode: "sdk" as const, model: "", timeoutMs: 5_000 };
}

function runInput(onEvent?: (event: ProviderEvent) => void) {
  return { issueId: 1, projectId: "project", cwd, prompt: "run", onEvent };
}

function state(value: "idle" | "running") {
  return { type: "system", subtype: "session_state_changed", state: value, session_id: SESSION, uuid: crypto.randomUUID() };
}

function init(uuid: string) {
  return { type: "system", subtype: "init", session_id: SESSION, uuid, model: "claude", permissionMode: "dontAsk" };
}

function success(uuid: string, result: string) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: SESSION,
    uuid,
    total_cost_usd: 0.001,
    usage: { input_tokens: 1, output_tokens: 1 }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for condition");
}
