import { NODE_PROVIDER_READ_METHODS, type NodeProviderInfo } from "../db/repositories/nodes.ts";
import { isProviderInterruptedError, type ExecutorProvider, type ProviderEvent } from "../providers/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCommandHandler } from "./agent.ts";
import { materializeRunAttachments } from "./runAttachments.ts";
import {
  isTerminalProviderEvent,
  type NodeApprovalResolveParams,
  type NodeRunEvent,
  type NodeRunInterruptParams,
  type NodeRunStartParams
} from "./protocol.ts";

/** 节点向中心开放的能力；会话的创建与续写不开放，只开放读取。 */
const REMOTE_CAPABILITIES = ["issue_execution", "interrupt", "approvals", "model_list"] as const;
type ReadMethod = (typeof NODE_PROVIDER_READ_METHODS)[number];

type ProviderSource = () => Record<string, ExecutorProvider>;

/** 节点上真实执行 provider 的命令处理器：run.start / run.interrupt / approval.resolve。 */
/** workDir：节点缓存托管 Skill、存放运行附件的目录。 */
export function nodeExecutionHandlers(
  providers: ProviderSource,
  options: { workDir?: string } = {}
): Record<string, NodeCommandHandler> {
  const workDir = options.workDir ?? join(tmpdir(), "xuanwu-node");
  const activeRuns = new Set<string>();
  return {
    "run.start": async (params, agent) => {
      const { images, input, providerId, runRef, skillPackages } = parseRunStart(params);
      // 中心可能因超时重发同一指令；运行已在进行时直接确认，不重复启动。
      if (activeRuns.has(runRef)) return { accepted: true };
      const provider = requireProvider(providers, providerId, "issue_execution");
      const cwd = await agent.resolveAllowedPath(input.cwd);
      const attachments = await materializeRunAttachments(workDir, runRef, { images, skillPackages }, input);
      activeRuns.add(runRef);
      const emit = (event: NodeRunEvent) => agent.emitRunEvent(runRef, event);
      // run() 返回后 provider 仍可能推送事件；返回且见到终止事件（或失败）才结束转发。
      let returned = false;
      let terminal = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        activeRuns.delete(runRef);
        agent.finishRun(runRef);
        void attachments.cleanup();
      };
      const onEvent = (event: ProviderEvent) => {
        if (finished) return;
        emit({ type: "event", event });
        if (!isTerminalProviderEvent(event)) return;
        terminal = true;
        if (returned) finish();
      };
      void provider.run({ ...input, cwd, onEvent, prompt: attachments.prompt, ...(attachments.images ? { images: attachments.images } : {}) })
        .then((result) => {
          emit({ type: "result", result });
          returned = true;
          if (terminal) finish();
        })
        .catch((error: unknown) => {
          emit({
            type: "error",
            interrupted: isProviderInterruptedError(error),
            message: error instanceof Error ? error.message : String(error)
          });
          finish();
        });
      return { accepted: true };
    },
    "run.interrupt": async (params) => {
      const { input, providerId } = params as NodeRunInterruptParams;
      const provider = requireProvider(providers, String(providerId ?? ""), "interrupt");
      await provider.interrupt!(input);
      return { ok: true };
    },
    // 中心验收读取会话摘要、项目编辑读取模型列表；仅限白名单内的只读方法。
    "provider.read": async (params) => {
      const { args, method, providerId } = params as { args?: unknown[]; method?: string; providerId?: string };
      if (!(NODE_PROVIDER_READ_METHODS as readonly string[]).includes(String(method))) throw new Error(`provider.read ${String(method)} is not allowed`);
      const provider = providers()[String(providerId ?? "")];
      const fn = provider?.[method as ReadMethod] as ((...values: unknown[]) => Promise<unknown>) | undefined;
      if (!provider || typeof fn !== "function") throw new Error(`provider ${String(providerId)} does not support ${String(method)}`);
      return await fn.apply(provider, Array.isArray(args) ? args.slice(0, 2) : []);
    },
    "approval.resolve": async (params) => {
      const { decision, providerId, requestId } = params as NodeApprovalResolveParams;
      const provider = requireProvider(providers, String(providerId ?? ""), "approvals");
      await provider.resolveApproval!(String(requestId ?? ""), decision);
      return { ok: true };
    }
  };
}

/** 握手时上报的 provider 列表。 */
export function nodeProviderInfo(providers: Record<string, ExecutorProvider>): NodeProviderInfo[] {
  return Object.values(providers).map((provider) => {
    const status = provider.runtimeStatus?.();
    return {
      capabilities: REMOTE_CAPABILITIES.filter((capability) => supports(provider, capability)),
      id: provider.id,
      ...(provider.interruptScope ? { interrupt_scope: provider.interruptScope } : {}),
      read_methods: NODE_PROVIDER_READ_METHODS.filter((method) => typeof provider[method] === "function"),
      ready: status?.ready ?? true,
      ...(status?.reason ? { reason: status.reason } : {}),
      ...(status?.version ? { version: status.version } : {})
    };
  });
}

function supports(provider: ExecutorProvider, capability: (typeof REMOTE_CAPABILITIES)[number]): boolean {
  if (!provider.capabilities.includes(capability)) return false;
  if (capability === "interrupt") return typeof provider.interrupt === "function";
  if (capability === "approvals") return typeof provider.resolveApproval === "function";
  if (capability === "model_list") return typeof provider.listModels === "function";
  return true;
}

function requireProvider(
  providers: ProviderSource,
  providerId: string,
  capability: (typeof REMOTE_CAPABILITIES)[number]
): ExecutorProvider {
  const provider = providers()[providerId];
  if (!provider) throw new Error(`provider ${providerId} is not available on this node`);
  if (!supports(provider, capability)) throw new Error(`provider ${providerId} does not support ${capability}`);
  return provider;
}

function parseRunStart(params: unknown): NodeRunStartParams {
  const value = params as Partial<NodeRunStartParams> | null;
  const runRef = typeof value?.runRef === "string" ? value.runRef.trim() : "";
  const providerId = typeof value?.providerId === "string" ? value.providerId.trim() : "";
  if (runRef === "" || providerId === "" || typeof value?.input !== "object" || value.input === null) {
    throw new Error("invalid run.start params");
  }
  if (typeof value.input.cwd !== "string" || typeof value.input.prompt !== "string") throw new Error("run.start input needs cwd and prompt");
  return {
    input: value.input,
    providerId,
    runRef,
    ...(Array.isArray(value.images) ? { images: value.images } : {}),
    ...(Array.isArray(value.skillPackages) ? { skillPackages: value.skillPackages } : {})
  };
}
