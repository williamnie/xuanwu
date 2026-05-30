import { type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const DISABLED_WRITE_TOOLS = ["edit", "write", "bash"] as const;
const RESPONSE_PREVIEW_SUFFIX = "...";
const TOOL_RESULT_PREVIEW_MAX = 100;
const SMOKE_RESPONSE = "pi-smoke-response-ok";
const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
const PI_PACKAGE_RELATIVE_DIR = join("backend-ts", "node_modules", "@earendil-works", "pi-coding-agent");

type SmokeRuntimeConfig = {
  events: boolean;
  toolsReadonly: boolean;
};

type EventSummary = {
  index: number;
  type: string;
  role?: string;
  assistantEvent?: string;
  toolName?: string;
  isError?: boolean;
};

type ToolProbe = {
  name: string;
  expected: "success" | "blocked";
  observed: "success" | "failure" | "missing";
  isError: boolean | null;
  resultPreview?: string;
};

type SmokeCollector = {
  events: EventSummary[];
  toolProbes: Map<string, ToolProbe>;
};

export type PromptResult = {
  responseText: string;
  events: EventSummary[];
  toolProbes: ToolProbe[];
};

export type SmokeRuntime = {
  ai: typeof import("@earendil-works/pi-ai");
  pi: typeof import("@earendil-works/pi-coding-agent");
};

export function resolveDefaultRepoRoot(fallbackCwd = ""): string {
  if (!isCompiledBunExecutable()) return resolve(import.meta.dirname, "../../..");

  const cwd = process.cwd();
  const current = basename(cwd) === "backend-ts" ? resolve(cwd, "..") : cwd;
  if (hasPiPackage(current)) return current;
  return hasPiPackage(fallbackCwd) ? resolve(fallbackCwd) : current;
}

export async function loadSmokeRuntime(repoRoot: string): Promise<SmokeRuntime> {
  ensurePiPackageDir(repoRoot);
  const [pi, ai] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai")
  ]);
  return { ai, pi };
}

export function buildReadOnlyToolCallResponse() {
  return fauxAssistantMessage([
    fauxToolCall("read", { path: "backend-ts/package.json", limit: 20 }, { id: "smoke-read" }),
    fauxToolCall("grep", {
      pattern: "piSmoke",
      path: "backend-ts/src/spikes",
      literal: true,
      limit: 5
    }, { id: "smoke-grep" }),
    fauxToolCall("find", { pattern: "piSmoke.ts", path: "backend-ts/src/spikes", limit: 5 }, { id: "smoke-find" }),
    fauxToolCall("ls", { path: "backend-ts/src/spikes", limit: 20 }, { id: "smoke-ls" }),
    fauxToolCall("write", { path: "backend-ts/tmp/blocked-write.txt", content: "must-not-write" }, { id: "smoke-write-blocked" }),
    fauxToolCall("edit", {
      path: "backend-ts/src/spikes/piSmoke.ts",
      edits: [{ oldText: "must-not-exist", newText: "must-not-write" }]
    }, { id: "smoke-edit-blocked" }),
    fauxToolCall("bash", { command: "echo must-not-run", timeout: 1000 }, { id: "smoke-bash-blocked" })
  ], { stopReason: "toolUse" });
}

export async function runPrompt(
  session: AgentSession,
  config: SmokeRuntimeConfig
): Promise<PromptResult> {
  const collector = createCollector(config);
  const unsubscribe = collector
    ? session.subscribe((event) => recordSessionEvent(collector, event))
    : undefined;

  try {
    await session.prompt(`Reply with ${SMOKE_RESPONSE}.`, {
      expandPromptTemplates: false,
      source: "rpc"
    });
  } finally {
    unsubscribe?.();
  }

  return {
    responseText: collectAssistantText(session.state.messages),
    events: collector?.events ?? [],
    toolProbes: collector ? finalizeToolProbes(collector) : []
  };
}

export function buildEventsSummary(config: SmokeRuntimeConfig, events: EventSummary[]) {
  if (!config.events) return { enabled: false, ok: true };
  const order = events.map((event) => {
    const role = event.role ? `:${event.role}` : "";
    const assistantEvent = event.assistantEvent ? `:${event.assistantEvent}` : "";
    const tool = event.toolName ? `:${event.toolName}` : "";
    const error = event.isError === undefined ? "" : event.isError ? ":error" : ":ok";
    return `${event.index}:${event.type}${role}${assistantEvent}${tool}${error}`;
  });
  const eventTypes = new Set(events.map((event) => event.type));
  return {
    enabled: true,
    ok: eventTypes.has("agent_start") && eventTypes.has("agent_end"),
    keyOrder: order,
    count: events.length
  };
}

export function buildToolBoundarySummary(
  config: SmokeRuntimeConfig,
  session: AgentSession,
  probes: ToolProbe[]
) {
  if (!config.toolsReadonly) return { enabled: false, ok: true };
  const activeTools = session.getActiveToolNames();
  const allTools = session.getAllTools().map((tool) => tool.name);
  const disabledTools = [...DISABLED_WRITE_TOOLS].map((name) => ({
    name,
    active: activeTools.includes(name),
    registered: allTools.includes(name)
  }));
  const expectedToolBehavior = new Map(probes.map((probe) => [probe.name, probe]));
  const allowedOk = READ_ONLY_TOOLS.every((name) => expectedToolBehavior.get(name)?.observed === "success");
  const disabledOk = DISABLED_WRITE_TOOLS.every((name) => {
    const probe = expectedToolBehavior.get(name);
    return probe?.observed === "failure" && probe.isError === true;
  });
  const boundaryOk = disabledTools.every((tool) => !tool.active && !tool.registered);

  return {
    enabled: true,
    ok: allowedOk && disabledOk && boundaryOk,
    requestedTools: [...READ_ONLY_TOOLS],
    activeTools,
    registeredTools: allTools,
    disabledTools,
    probes,
    boundary: "read/grep/find/ls enabled; edit/write/bash are not registered or active in this smoke session"
  };
}

function createCollector(config: SmokeRuntimeConfig): SmokeCollector | undefined {
  if (!config.events && !config.toolsReadonly) return undefined;
  return { events: [], toolProbes: new Map() };
}

function recordSessionEvent(collector: SmokeCollector, event: AgentSessionEvent): void {
  const summary: EventSummary = { index: collector.events.length + 1, type: event.type };
  if (event.type === "message_start" || event.type === "message_end") summary.role = event.message.role;
  if (event.type === "message_update") {
    summary.role = event.message.role;
    summary.assistantEvent = event.assistantMessageEvent.type;
  }
  if (event.type === "tool_execution_start") summary.toolName = event.toolName;
  if (event.type === "tool_execution_end") {
    summary.toolName = event.toolName;
    summary.isError = event.isError;
    recordToolProbe(collector, event.toolName, event.isError, event.result);
  }
  collector.events.push(summary);
}

function recordToolProbe(
  collector: SmokeCollector,
  name: string,
  isError: boolean,
  result: { content?: unknown }
): void {
  const expected = isDisabledWriteTool(name) ? "blocked" : "success";
  collector.toolProbes.set(name, {
    name,
    expected,
    observed: isError ? "failure" : "success",
    isError,
    resultPreview: summarizeToolText(collectTextContent(result.content))
  });
}

function finalizeToolProbes(collector: SmokeCollector): ToolProbe[] {
  const probes = [...collector.toolProbes.values()];
  for (const name of [...READ_ONLY_TOOLS, ...DISABLED_WRITE_TOOLS]) {
    if (collector.toolProbes.has(name)) continue;
    probes.push({
      name,
      expected: isDisabledWriteTool(name) ? "blocked" : "success",
      observed: "missing",
      isError: null
    });
  }
  return probes.sort((left, right) => toolOrder(left.name) - toolOrder(right.name));
}

function collectAssistantText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return collectTextContent(lastAssistant?.content).replace(/\n/g, "");
}

function collectTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null &&
        "type" in block && block.type === "text" &&
        "text" in block && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function isDisabledWriteTool(name: string): boolean {
  return DISABLED_WRITE_TOOLS.includes(name as (typeof DISABLED_WRITE_TOOLS)[number]);
}

function summarizeToolText(text: string): string {
  return truncateText(redactSensitiveText(text), TOOL_RESULT_PREVIEW_MAX);
}

function truncateText(text: string, maxLength: number): string {
  const contentLength = maxLength - RESPONSE_PREVIEW_SUFFIX.length;
  return text.length > maxLength
    ? `${text.slice(0, contentLength)}${RESPONSE_PREVIEW_SUFFIX}`
    : text;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(/(api[_-]?key|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
}

function toolOrder(name: string): number {
  const order = [...READ_ONLY_TOOLS, ...DISABLED_WRITE_TOOLS];
  const index = order.indexOf(name as never);
  return index === -1 ? order.length : index;
}

function isCompiledBunExecutable(): boolean {
  return import.meta.url.includes("$bunfs") ||
    import.meta.url.includes("~BUN") ||
    import.meta.url.includes("%7EBUN");
}

function ensurePiPackageDir(repoRoot: string): void {
  if (process.env[PI_PACKAGE_DIR_ENV]) return;

  const candidates = [
    join(repoRoot, PI_PACKAGE_RELATIVE_DIR),
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent")
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      process.env[PI_PACKAGE_DIR_ENV] = candidate;
      return;
    }
  }
}

function hasPiPackage(path: string): boolean {
  return path.trim() !== "" && existsSync(join(path, PI_PACKAGE_RELATIVE_DIR, "package.json"));
}
