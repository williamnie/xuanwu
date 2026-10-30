import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { type ProviderEvent } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { createIssueLogPersistence } from "./issueLogPersistence.ts";
import { createBoundedPersistenceQueue } from "./boundedPersistenceQueue.ts";
import { parseProviderOutcomeMarker, reconcileProviderOutcome } from "./providerOutcome.ts";
import { recordExecutorMemoryCitations } from "../pi/memory/runMemoryContext.ts";
import { LIVE_PROVIDER_PAYLOAD_MAX_BYTES } from "./providerRuntime.model.ts";
import type { RunnerIssueExecutionInput } from "./providerRuntime.model.ts";
import { issueLogMode, persistRunnerOutcomeMarker, processRuntimeEvent } from "./providerRuntime.outcomes.ts";
import { persistRuntimeEvent, eventSessionStatus, providerTerminalOutcome } from "./providerRuntime.persistence.ts";
import { compactAppEvent, rawPayloadText } from "./providerRuntime.publication.ts";

/**
 * 重新接上一次已在别处启动的运行（中心重启后，远程节点上的运行仍在继续）：
 * 用与正常执行相同的事件落库与终止收口链路处理后续事件。运行已不是当前尝试时事件被丢弃。
 */
export function reattachProviderEventSink(input: {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  issueId: number;
  issueRunId: string;
  projectId: string;
}): { flush(): Promise<void>; push(event: ProviderEvent): void } {
  const runtimeInput: RunnerIssueExecutionInput = {
    bus: input.bus,
    cwd: "",
    database: input.database,
    issueId: input.issueId,
    issueRunId: input.issueRunId,
    projectId: input.projectId,
    prompt: ""
  };
  const sink = providerEventSink(runtimeInput, input.issueRunId, activeAttemptSequence(runtimeInput, input.issueRunId, 0));
  return { flush: () => sink.flush(), push: (event) => sink.push(event) };
}

export function activeAttemptSequence(input: RunnerIssueExecutionInput, runID: string, fallback: number): number {
  return input.database?.sqlite.query<{ sequence: number }, [string]>(
    "select sequence from run_attempts where issue_run_id=? order by sequence desc limit 1"
  ).get(runID)?.sequence ?? fallback;
}

export function providerEventSink(input: RunnerIssueExecutionInput, activeRunID: string, activeAttempt: number) {
  const mode = issueLogMode(input);
  const currentAttempt = () => {
    if (!input.database || !activeRunID) return true;
    const current = input.database.sqlite.query<{ id: string; sequence: number; status: string }, [number]>(`
      select ir.id, ra.sequence, i.status from issues i join issue_runs ir on ir.issue_id=i.id
      join run_attempts ra on ra.issue_run_id=ir.id where i.id=?
      order by ir.attempt desc, ra.sequence desc limit 1
    `).get(input.issueId);
    return current?.status === "in_progress" && current.id === activeRunID && current.sequence === activeAttempt;
  };
  const queue = createBoundedPersistenceQueue<{ kind: "log" | "terminal" | "marker"; serialized: string }>(async (task) => {
    if (!currentAttempt()) return;
    const event = JSON.parse(task.serialized) as ProviderEvent;
    if ((event.type === "provider.message" || event.type === "text") && !event.command && event.text && input.database) {
      recordExecutorMemoryCitations(input.database, input.issueId, activeRunID, event.text);
    }
    if (task.kind === "log") {
      await persistRuntimeEvent(input, event, activeRunID, activeAttempt);
    } else if (task.kind === "marker") {
      persistRunnerOutcomeMarker(input, event, activeRunID);
    } else {
      await reconcileTerminalEvent(input, event, activeRunID);
    }
  });
  const enqueue = (kind: "log" | "terminal" | "marker", event: ProviderEvent) => {
    try {
      const serialized = JSON.stringify(event);
      queue.push({ kind, serialized }, Buffer.byteLength(serialized));
    } catch (error) {
      // 定时 flush 的写入错误也留给 Run flush 传播，避免未捕获的 timer 异常。
      queue.fail(error);
    }
  };
  const persistence = createIssueLogPersistence((event) => {
    enqueue("log", event);
  }, { mode });
  let failure = false;
  let sessionObserved = false;
  return {
    async flush() {
      try {
        persistence.flush();
      } finally {
        await queue.flush();
      }
    },
    mode,
    hasFailure: () => failure,
    push(event: ProviderEvent) {
      if (!currentAttempt()) return;
      queue.throwIfFailed();
      if (event.runEvent?.kind === "error") failure = true;
      input.onLog?.(event);
      publishLiveProviderEvent(input, event);
      const persistSession = Boolean(event.session) &&
        (!sessionObserved || eventSessionStatus(event) !== "");
      processRuntimeEvent(input, event, activeRunID, persistSession);
      if (event.session) sessionObserved = true;
      if (parseProviderOutcomeMarker(event.text)) enqueue("marker", event);
      persistence.push(event);
      const terminalOutcome = providerTerminalOutcome(event);
      if (terminalOutcome && input.database) {
        enqueue("terminal", event);
      }
      queue.throwIfFailed();
      input.onRuntimeEvent?.(event);
    }
  };
}

export async function reconcileTerminalEvent(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  activeRunID: string
): Promise<void> {
  const terminalOutcome = providerTerminalOutcome(event);
  if (!input.database || !terminalOutcome) return;
  try {
    await reconcileProviderOutcome({
      bus: input.bus,
      database: input.database,
      issueID: input.issueId,
      issueRunID: activeRunID,
      providerID: event.provider,
      providerTurnID: event.session?.turnId,
      reportedOutcome: parseProviderOutcomeMarker(event.text) ?? terminalOutcome
    });
  } catch (error) {
    input.onLog?.({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      provider: event.provider,
      raw: { method: "runtime/provider_outcome_reconcile_error" },
      status: "failed",
      type: "error"
    });
  }
}

export function publishLiveProviderEvent(input: RunnerIssueExecutionInput, event: ProviderEvent): void {
  const payload = liveProviderPayload(event);
  input.bus?.publish(compactAppEvent({
    type: "agent.event",
    issueId: input.issueId,
    projectId: input.projectId,
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    method: event.raw?.method,
    raw_method: event.raw?.method,
    payload,
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error
  }));
}

export function liveProviderPayload(event: ProviderEvent): string | undefined {
  const value = rawPayloadText(event.raw?.payload) ?? rawPayloadText(event.payload);
  if (!value || Buffer.byteLength(value) > LIVE_PROVIDER_PAYLOAD_MAX_BYTES) return undefined;
  return value;
}
