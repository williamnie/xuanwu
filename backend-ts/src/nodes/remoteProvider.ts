import { randomUUID } from "node:crypto";
import type { NodeProviderInfo, RemoteNode } from "../db/repositories/nodes.ts";
import { claudeManifest } from "../providers/claude/factory.ts";
import { claudeExecutionPolicyAdapter } from "../providers/claude/executionPolicy.ts";
import { codexManifest } from "../providers/codex/factory.ts";
import { codexExecutionPolicyAdapter } from "../providers/codex/executionPolicy.ts";
import type { ExecutorProviderManifest } from "../providers/core/manifest.ts";
import type { ProviderPolicyAdapter } from "../providers/core/policyContracts.ts";
import { piManifest } from "../providers/pi/factory.ts";
import { piExecutionPolicyAdapter } from "../providers/pi/executionPolicy.ts";
import { qoderManifest } from "../providers/qoder/factory.ts";
import { qoderExecutionPolicyAdapter } from "../providers/qoder/executionPolicy.ts";
import {
  asProviderId,
  ProviderInterruptedError,
  type ExecutorCapability,
  type ExecutorProvider,
  type ProviderRunInput,
  type ProviderRunResult
} from "../providers/types.ts";
import { NodeOfflineError, type NodeHub } from "./hub.ts";
import type { NodeRunEvent, NodeRunStartParams } from "./protocol.ts";

/** 节点断线后，在途运行等待其重连的时长；超时按节点离线失败。 */
const DEFAULT_OFFLINE_GRACE_MS = 10 * 60_000;

/** 内置 provider 的 manifest 与策略适配器是静态的：中心即使未启用该 provider，也能为远程运行解析执行策略。 */
const BUILTIN_POLICY: Record<string, () => { manifest: ExecutorProviderManifest; policyAdapter: ProviderPolicyAdapter }> = {
  claude: () => ({ manifest: claudeManifest(), policyAdapter: claudeExecutionPolicyAdapter }),
  codex: () => ({ manifest: codexManifest(), policyAdapter: codexExecutionPolicyAdapter }),
  "pi-coding-agent": () => ({ manifest: piManifest(), policyAdapter: piExecutionPolicyAdapter }),
  qoder: () => ({ manifest: qoderManifest(), policyAdapter: qoderExecutionPolicyAdapter })
};

type RemoteProviderOptions = {
  hub: NodeHub;
  nodeId: string;
  offlineGraceMs?: number;
  provider: NodeProviderInfo;
};

/** 节点上报的全部 provider，各包装成一个中心侧 ExecutorProvider。 */
export function remoteProvidersForNode(
  hub: NodeHub,
  node: Pick<RemoteNode, "id" | "info">,
  options: { offlineGraceMs?: number } = {}
): Record<string, ExecutorProvider> {
  const providers: Record<string, ExecutorProvider> = {};
  for (const provider of node.info.providers) {
    providers[provider.id] = createRemoteExecutorProvider({ hub, nodeId: node.id, offlineGraceMs: options.offlineGraceMs, provider });
  }
  return providers;
}

/**
 * 中心侧代理：run/interrupt/resolveApproval 转为发往节点的指令，节点回传的事件原样交给 onEvent，
 * 因而 runIssueWithProvider 之后的持久化、审批、结果判定逻辑与本地 provider 完全一致。
 */
export function createRemoteExecutorProvider(options: RemoteProviderOptions): ExecutorProvider {
  const { hub, nodeId, provider } = options;
  const id = asProviderId(provider.id);
  const capabilities = provider.capabilities as ExecutorCapability[];
  const policy = BUILTIN_POLICY[provider.id]?.();
  const remote: ExecutorProvider = {
    id,
    capabilities,
    ...(policy ?? {}),
    ...(provider.interrupt_scope ? { interruptScope: provider.interrupt_scope } : {}),
    run: (input) => runRemote(options, input),
    runtimeStatus: () => ({
      active_sessions: 0,
      api_key_configured: false,
      mode: "remote",
      ready: provider.ready && hub.isOnline(nodeId),
      ...(provider.ready && !hub.isOnline(nodeId) ? { reason: "node offline" } : provider.reason ? { reason: provider.reason } : {}),
      version: provider.version ?? ""
    })
  };
  if (capabilities.includes("interrupt")) {
    remote.interrupt = async (input) => {
      await hub.request(nodeId, "run.interrupt", { input, providerId: provider.id });
    };
  }
  if (capabilities.includes("approvals")) {
    remote.resolveApproval = async (requestId, decision) => {
      await hub.request(nodeId, "approval.resolve", { decision, providerId: provider.id, requestId });
    };
  }
  return remote;
}

function runRemote(options: RemoteProviderOptions, input: ProviderRunInput): Promise<ProviderRunResult> {
  const { hub, nodeId, provider } = options;
  const runRef = `rr_${randomUUID()}`;
  const graceMs = options.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS;
  return new Promise<ProviderRunResult>((resolve, reject) => {
    let offlineTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error: Error | undefined, result?: ProviderRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(offlineTimer);
      unsubscribe();
      stopWatching();
      if (error) reject(error);
      else resolve(result!);
    };
    const unsubscribe = hub.subscribeRun(runRef, (payload) => {
      const message = payload as NodeRunEvent;
      if (message.type === "event") input.onEvent?.(message.event);
      else if (message.type === "result") finish(undefined, message.result);
      else if (message.type === "error") {
        finish(message.interrupted ? new ProviderInterruptedError(message.message) : new Error(message.message));
      }
    });
    // 节点断线不立刻判失败：节点上的运行仍在继续，重连后会补发事件。
    const stopWatching = hub.onStatusChange((changedNodeId, online) => {
      if (changedNodeId !== nodeId) return;
      clearTimeout(offlineTimer);
      offlineTimer = online ? undefined : setTimeout(() => {
        finish(new NodeOfflineError(`node ${nodeId} stayed offline for ${graceMs}ms during the run`));
      }, graceMs);
    });
    const { images: _images, onEvent: _onEvent, ...remoteInput } = input;
    const params: NodeRunStartParams = { input: remoteInput, providerId: provider.id, runRef };
    hub.request(nodeId, "run.start", params).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
