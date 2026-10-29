import type { RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { finishRemoteRun, listActiveRemoteRuns, recordRemoteRunStart, type RemoteRun } from "../db/repositories/remoteRuns.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { reconcileProviderOutcome } from "../runner/providerOutcome.ts";
import { reattachProviderEventSink } from "../runner/providerRuntime.ts";
import { NodeHub } from "./hub.ts";
import type { NodeGitRunResult } from "./nodeGit.ts";
import { projectLocation } from "./projectLocation.ts";
import { isTerminalProviderEvent, type NodeRunEvent } from "./protocol.ts";
import { installRemoteProviderResolver, rememberRemoteApproval } from "./remoteExecution.ts";
import { installRemoteGitRunner } from "./remoteGit.ts";
import { remoteProvidersForNode, type RemoteRunLedger } from "./remoteProvider.ts";
import { redactSensitiveText } from "../util/redact.ts";

type ProviderMap = Partial<Record<ExecutorProviderId, ExecutorProvider>>;

/** 与 providerApprovalRequests 相同的审批 ID 取值顺序。 */
function approvalRequestId(event: AppEvent): string {
  const raw = event.raw_payload ?? event.payload;
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return "";
  }
  const params = (payload.params ?? {}) as Record<string, unknown>;
  const id = payload.id ?? params.approvalId ?? params.itemId ?? params.callId;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/** 后台收口任务脱离了路由的异常边界；同步写库遇锁等失败只记日志，不能变成未处理拒绝拖垮 Core。 */
export function background(task: () => Promise<unknown>, event: string, runRef: string): void {
  // 套一层 async，任务同步抛出也落到同一个 catch。
  void (async () => await task())().catch((error: unknown) => {
    console.error(JSON.stringify({
      event,
      ...(runRef ? { run_ref: runRef } : {}),
      error: redactSensitiveText(error instanceof Error ? error.message : String(error))
    }));
  });
}

/** 中心启动后等待节点重连、接回在途运行的时长；超时仍未回来的运行按丢失收口。 */
const DEFAULT_REATTACH_GRACE_MS = 10 * 60_000;

type HubRuntimeOptions = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  /** 节点上线时唤醒其项目的任务循环（排队中的任务在节点离线期间等待）。 */
  onNodeOnline?: (projectIds: string[]) => void;
  reattachGraceMs?: number;
};

/**
 * Core 侧的节点运行时：创建 NodeHub，安装「项目 → 节点 provider」与远程 git 入口，
 * 并维护远程运行台账，使中心重启或节点重启后在途运行得以接回或及时收口（无人值守所需）。
 */
export function startNodeHubRuntime(options: HubRuntimeOptions): { hub: NodeHub; stop(): void } {
  const { database } = options;
  const hub = new NodeHub();
  const cache = new Map<string, { providers: ProviderMap; version: string }>();
  const ledger: RemoteRunLedger = {
    finished: (runRef) => finishRemoteRun(database, runRef),
    started: (runRef, input, providerId) => {
      const run = listIssueRuns(database, input.issueId).at(-1);
      const nodeId = projectLocation(input.cwd).nodeId;
      if (!run || run.ended_at !== "" || nodeId === "") return;
      recordRemoteRunStart(database, {
        issue_id: input.issueId, issue_run_id: run.id, node_id: nodeId,
        project_id: input.projectId, provider: providerId, run_ref: runRef
      });
    }
  };
  const uninstall = installRemoteProviderResolver((nodeId) => {
    const node = getRemoteNode(database, nodeId);
    if (!node || node.revoked_at !== "") return {};
    const cached = cache.get(nodeId);
    if (cached?.version === node.updated_at) return cached.providers;
    const providers = remoteProvidersForNode(hub, node, { ledger });
    cache.set(nodeId, { providers, version: node.updated_at });
    return providers;
  });
  // 中心验收链路的只读 git 经节点执行；给节点留出网络往返余量。
  const uninstallGit = installRemoteGitRunner(async (nodeId, input) => (
    await hub.request(nodeId, "git.run", input, input.timeoutMs + 5_000) as NodeGitRunResult
  ));
  const stopWatching = hub.onStatusChange((nodeId, online) => {
    if (!online || !options.onNodeOnline) return;
    const projectIds = listProjects(database)
      .filter((project) => projectLocation(project.cwd).nodeId === nodeId)
      .map((project) => project.id);
    if (projectIds.length > 0) options.onNodeOnline(projectIds);
  });
  // 节点的会话事件进入中心总线：前端会话页实时展示、飞书审批通知与本机会话一致；
  // 审批请求记下来源节点，审批时路由回该节点。
  const stopAppEvents = hub.onAppEvent((nodeId, payload) => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as AppEvent;
    if (event.method === "approval/requested" || event.raw_method === "approval/requested") {
      rememberRemoteApproval(approvalRequestId(event), nodeId);
    }
    options.bus?.publish(event);
  });
  const stopHello = hub.onHello((nodeId, activeRuns) => {
    const reported = new Set(activeRuns);
    for (const run of listActiveRemoteRuns(database, nodeId)) {
      if (reported.has(run.run_ref)) {
        if (!hub.hasRunListener(run.run_ref)) reattach(run);
      } else if (hub.hasRunListener(run.run_ref)) {
        // 中心仍在等这次运行，但节点已不再持有它（节点重启）：让等待方立即失败。
        hub.failRun(run.run_ref, `node ${nodeId} restarted and lost the run`);
      } else {
        background(() => closeLostRun(run, `node ${nodeId} restarted and lost the run`), "nodes.close_lost_run_failed", run.run_ref);
      }
    }
  });

  /** 中心重启后接回节点上仍在执行的运行，事件走与正常执行相同的落库与终止收口链路。 */
  function reattach(run: RemoteRun): void {
    const sink = reattachProviderEventSink({
      bus: options.bus, database, issueId: run.issue_id, issueRunId: run.issue_run_id, projectId: run.project_id
    });
    recordIssueEvent(database, run.issue_id, "issue.remote_run_reattached.v1", { issue_run_id: run.issue_run_id, node_id: run.node_id, run_ref: run.run_ref });
    const stop = hub.subscribeRun(run.run_ref, (payload) => {
      const message = payload as NodeRunEvent;
      if (message.type === "event") {
        sink.push(message.event);
        if (isTerminalProviderEvent(message.event)) background(done, "nodes.reattached_run_finish_failed", run.run_ref);
      } else if (message.type === "error") {
        background(async () => {
          await done();
          if (!message.interrupted) await closeLostRun(run, message.message);
        }, "nodes.reattached_run_finish_failed", run.run_ref);
      }
    });
    const done = async () => {
      stop();
      finishRemoteRun(database, run.run_ref);
      await sink.flush().catch(() => {});
    };
  }

  async function closeLostRun(run: RemoteRun, reason: string): Promise<void> {
    finishRemoteRun(database, run.run_ref);
    recordIssueEvent(database, run.issue_id, "issue.remote_run_lost.v1", { issue_run_id: run.issue_run_id, node_id: run.node_id, reason, run_ref: run.run_ref });
    await reconcileProviderOutcome({
      bus: options.bus,
      database,
      issueID: run.issue_id,
      issueRunID: run.issue_run_id,
      providerID: run.provider as ExecutorProviderId,
      reportedOutcome: { outcome: "failed", reason }
    });
  }

  // 中心刚启动时台账里可能有上次遗留的在途运行：宽限期内节点重连即接回，否则按丢失收口。
  const graceTimer = setTimeout(() => {
    background(async () => {
      for (const run of listActiveRemoteRuns(database)) {
        if (!hub.hasRunListener(run.run_ref)) {
          background(() => closeLostRun(run, `node ${run.node_id} did not reconnect after the hub restarted`), "nodes.close_lost_run_failed", run.run_ref);
        }
      }
    }, "nodes.reattach_grace_failed", "");
  }, options.reattachGraceMs ?? DEFAULT_REATTACH_GRACE_MS);
  graceTimer.unref?.();

  return {
    hub,
    stop() {
      clearTimeout(graceTimer);
      stopAppEvents();
      stopHello();
      stopWatching();
      uninstallGit();
      uninstall();
    }
  };
}
