import type { RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { finishRemoteRun, listActiveRemoteRuns, recordRemoteRunStart, type RemoteRun } from "../db/repositories/remoteRuns.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { reconcileProviderOutcome } from "../runner/providerOutcome.ts";
import { reattachProviderEventSink } from "../runner/providerRuntime.ts";
import { NodeHub } from "./hub.ts";
import type { NodeGitRunResult } from "./nodeGit.ts";
import { projectLocation } from "./projectLocation.ts";
import { isTerminalProviderEvent, type NodeRunEvent } from "./protocol.ts";
import { installRemoteProviderResolver } from "./remoteExecution.ts";
import { installRemoteGitRunner } from "./remoteGit.ts";
import { remoteProvidersForNode, type RemoteRunLedger } from "./remoteProvider.ts";

type ProviderMap = Partial<Record<ExecutorProviderId, ExecutorProvider>>;

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
  const stopHello = hub.onHello((nodeId, activeRuns) => {
    const reported = new Set(activeRuns);
    for (const run of listActiveRemoteRuns(database, nodeId)) {
      if (reported.has(run.run_ref)) {
        if (!hub.hasRunListener(run.run_ref)) reattach(run);
      } else if (hub.hasRunListener(run.run_ref)) {
        // 中心仍在等这次运行，但节点已不再持有它（节点重启）：让等待方立即失败。
        hub.failRun(run.run_ref, `node ${nodeId} restarted and lost the run`);
      } else {
        void closeLostRun(run, `node ${nodeId} restarted and lost the run`);
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
        if (isTerminalProviderEvent(message.event)) void done();
      } else if (message.type === "error") {
        void done().then(() => message.interrupted ? undefined : closeLostRun(run, message.message));
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
    for (const run of listActiveRemoteRuns(database)) {
      if (!hub.hasRunListener(run.run_ref)) void closeLostRun(run, `node ${run.node_id} did not reconnect after the hub restarted`);
    }
  }, options.reattachGraceMs ?? DEFAULT_REATTACH_GRACE_MS);
  graceTimer.unref?.();

  return {
    hub,
    stop() {
      clearTimeout(graceTimer);
      stopHello();
      stopWatching();
      uninstallGit();
      uninstall();
    }
  };
}
