import type { RunnerDatabase } from "../db/database.ts";
import type { ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import type { ContextBundleSourceQuery } from "../db/repositories/contextBundles.ts";
import { invokeReadOnlyAssistantTool } from "./readOnlyToolInvocation.ts";
import { syncCliRawEvents } from "./cliRawEventSync.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";
import type { ToolCallAuditContext } from "./toolCallAudit.ts";
import type { AssistantTool, ToolProvider, ToolResult } from "./toolProviderEnvelope.ts";

type JsonObject = Record<string, unknown>;

export type ManualSourcePullOptions = {
  auditContext?: Partial<ToolCallAuditContext>;
  connectorManifestDirs?: string[];
  env?: Record<string, string | undefined>;
};

export type ManualSourcePullInput = {
  attachmentKinds?: string[];
  cursor?: string;
  limit?: number;
  messageID?: string;
  now: Date;
  providerID?: string;
  query: ContextBundleSourceQuery;
  requireAttachments?: boolean;
  source: string;
  threadKey?: string;
  toolName?: string;
};

export type ManualSourcePullResult = {
  event_count: number;
  events: ExternalEventRecord[];
  processed_watermark: string;
  provider_id: string;
  reason: "source_pull_completed";
  source: string;
  status: "succeeded";
  tool_name: string;
} | {
  provider_id?: string;
  reason: "source_pull_unavailable" | "source_pull_ambiguous" | "source_pull_unauthorized" | "source_pull_failed";
  status: "needs_user";
  text: string;
  tool_name?: string;
};

type SourcePullTarget = { provider: ToolProvider; tool: AssistantTool };
type SourcePullNeedsUserReason = Exclude<ManualSourcePullResult["reason"], "source_pull_completed">;
type TargetSelection = { target: SourcePullTarget } | { reason: SourcePullNeedsUserReason; text: string };

export async function pullManualSourceEvents(
  db: RunnerDatabase,
  input: ManualSourcePullInput,
  options: ManualSourcePullOptions = {}
): Promise<ManualSourcePullResult> {
  const selected = selectSourcePullTarget(db, input, options);
  if (!("target" in selected)) return { reason: selected.reason, status: "needs_user", text: selected.text };
  const toolInput = sourcePullToolInput(input);
  const result = await invokeReadOnlyAssistantTool({
    auditContext: options.auditContext,
    db,
    env: options.env,
    input: toolInput,
    manifestDirs: options.connectorManifestDirs,
    providerID: selected.target.provider.id,
    toolName: selected.target.tool.name
  });
  if (result.status !== "succeeded") return needsUserFromToolResult(input.source, selected.target, result);
  const sync = syncCliRawEvents(db, result.output, {
    defaultProvider: selected.target.provider.id,
    defaultSource: input.source,
    now: input.now
  });
  return {
    event_count: sync.events.length,
    events: sync.events,
    processed_watermark: sync.processed_watermark,
    provider_id: selected.target.provider.id,
    reason: "source_pull_completed",
    source: sync.source || input.source,
    status: "succeeded",
    tool_name: selected.target.tool.name
  };
}

export function listManualSourcePullSources(
  db: RunnerDatabase,
  options: ManualSourcePullOptions = {}
): string[] {
  const snapshot = loadAssistantToolRegistrySnapshot(db, {
    cliConnectorDirs: options.connectorManifestDirs ?? [],
    env: options.env
  });
  return unique([
    ...sourcePullTargets(snapshot.providers, snapshot.tools).map((target) => target.provider.id),
    ...snapshot.providers.filter((provider) => provider.kind === "cli" && provider.status === "disabled")
      .map((provider) => provider.id)
  ]).sort();
}

function selectSourcePullTarget(
  db: RunnerDatabase,
  input: ManualSourcePullInput,
  options: ManualSourcePullOptions
): TargetSelection {
  const snapshot = loadAssistantToolRegistrySnapshot(db, {
    cliConnectorDirs: options.connectorManifestDirs ?? [],
    env: options.env
  });
  const providers = snapshot.providers;
  const providerID = clean(input.providerID);
  const toolName = clean(input.toolName);
  const candidates = sourcePullTargets(providers, snapshot.tools);
  if (providerID !== "") return explicitTarget(input.source, providers, candidates, providerID, toolName);
  const bySource = candidates.filter((target) => target.provider.id === input.source);
  if (bySource.length === 1) return { target: bySource[0] };
  if (bySource.length > 1) return chooseByToolName(input.source, bySource, toolName);
  if (disabledProvider(providers, input.source)) return unauthorized(input.source, input.source, toolName);
  return autoTarget(input.source, candidates);
}

function explicitTarget(
  source: string,
  providers: ToolProvider[],
  candidates: SourcePullTarget[],
  providerID: string,
  toolName: string
): TargetSelection {
  const provider = providers.find((item) => item.id === providerID);
  if (provider?.status === "disabled") return unauthorized(source, providerID, toolName);
  const scoped = candidates.filter((target) => target.provider.id === providerID);
  if (scoped.length === 0) return unavailable(source, providerID, toolName);
  return chooseByToolName(source, scoped, toolName);
}

function chooseByToolName(source: string, targets: SourcePullTarget[], toolName: string): TargetSelection {
  if (toolName !== "") {
    const target = targets.find((item) => item.tool.name === toolName);
    return target ? { target } : unavailable(source, targets[0]?.provider.id ?? "", toolName);
  }
  return targets.length === 1
    ? { target: targets[0] }
    : ambiguous(source, targets);
}

function autoTarget(source: string, candidates: SourcePullTarget[]): TargetSelection {
  if (candidates.length === 1) return { target: candidates[0] };
  if (candidates.length > 1) return ambiguous(source, candidates);
  return unavailable(source, "", "");
}

function sourcePullTargets(providers: ToolProvider[], tools: AssistantTool[]): SourcePullTarget[] {
  const providerByID = new Map(providers.map((provider) => [provider.id, provider]));
  return tools
    .filter((tool) => tool.permission === "read" && isRawEventsPullTool(tool))
    .flatMap((tool) => {
      const provider = providerByID.get(tool.provider_id);
      return provider && provider.status !== "disabled" ? [{ provider, tool }] : [];
    });
}

function isRawEventsPullTool(tool: AssistantTool): boolean {
  const outputProperties = objectValue(tool.output_schema?.properties);
  const metadata = objectValue(tool.metadata);
  return "events" in outputProperties || clean(metadata.source_contract) === "raw_events";
}

function sourcePullToolInput(input: ManualSourcePullInput): JsonObject {
  const since = clean(input.query.since);
  const until = input.now.toISOString();
  return cleanObject({
    attachment_kinds: input.attachmentKinds,
    cursor: clean(input.cursor),
    limit: positiveInteger(input.limit) || positiveInteger(input.query.limit),
    message_id: clean(input.messageID || input.query.message_id),
    require_attachments: input.requireAttachments === true,
    since,
    source: input.source,
    thread_key: clean(input.threadKey || input.query.thread_key),
    time_window: cleanObject({ since, until }),
    until
  });
}

function needsUserFromToolResult(
  source: string,
  target: SourcePullTarget,
  result: ToolResult
): ManualSourcePullResult {
  const code = clean(result.error?.code);
  const reason = result.status === "denied" || /auth|permission|unauthor/i.test(code)
    ? "source_pull_unauthorized"
    : "source_pull_failed";
  return {
    provider_id: target.provider.id,
    reason,
    status: "needs_user",
    text: reason === "source_pull_unauthorized"
      ? authorizationText(source)
      : `来源 ${source} 的上下文拉取失败：${result.error?.message ?? result.status}`,
    tool_name: target.tool.name
  };
}

function unavailable(source: string, providerID: string, toolName: string): TargetSelection {
  const target = [providerID, toolName].filter(Boolean).join(":");
  return {
    reason: "source_pull_unavailable",
    text: `来源 ${source} 没有可用的 read-only pull connector${target ? `（${target}）` : ""}；请先授权、配置或同步该来源。`
  };
}

function ambiguous(source: string, targets: SourcePullTarget[]): TargetSelection {
  const names = targets.map((target) => `${target.provider.id}:${target.tool.name}`).slice(0, 5).join(", ");
  return {
    reason: "source_pull_ambiguous",
    text: `找到多个可能的来源 connector（${names}），请指定 source_provider_id/source_tool_name。${source ? ` 当前来源：${source}。` : ""}`
  };
}

function unauthorized(source: string, providerID: string, toolName: string): TargetSelection {
  return {
    reason: "source_pull_unauthorized",
    text: `${authorizationText(source)}${providerID ? `（${[providerID, toolName].filter(Boolean).join(":")}）` : ""}`
  };
}

function authorizationText(source: string): string {
  return `来源 ${source} 未授权或 connector 不允许只读拉取；请先完成授权/配置后重试。`;
}

function disabledProvider(providers: ToolProvider[], providerID: string): boolean {
  return providers.some((provider) => provider.id === providerID && provider.status === "disabled");
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cleanObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => !emptyValue(child)));
}

function emptyValue(value: unknown): boolean {
  return value === "" || value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(clean).filter(Boolean))];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
