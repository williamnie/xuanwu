import { dirname } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getPiSupervisor } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { appLanguage } from "../i18n/language.ts";
import type { CodexThreadTitleInput } from "../providers/codex/threadNaming.ts";
import { installPiProviderSecretOverride } from "../security/secrets/piProviderRuntime.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../spikes/piSmokeSupport.ts";
import { parseSessionTitle, sessionTitleSystemPrompt, sessionTitleDate, sessionTitleTimeZone } from "./sessionTitlePrompt.ts";

/** 复用 PI 配置和鉴权，直接调用模型一次；不创建 AgentSession 或挂载任何工具。 */
export async function generateSessionTitle(db: RunnerDatabase, input: CodexThreadTitleInput, signal: AbortSignal): Promise<string | null> {
  if (input.issueId !== undefined && (!Number.isSafeInteger(input.issueId) || input.issueId <= 0)) return null;
  const issue = input.issueId === undefined ? null : getIssue(db, input.issueId);
  if (input.issueId !== undefined && !issue) return null;
  const timeZone = issue ? null : sessionTitleTimeZone();
  const titleDate = issue ? null : sessionTitleDate(input.thread.createdAt, timeZone);
  const titlePrefix = issue ? `#${issue.id}` : titleDate;
  const agent = getPiSupervisor(db);
  if (!titlePrefix || !agent?.model_provider || !agent.model_id || signal.aborted) return null;
  const project = input.projectId ? getProject(db, input.projectId) : null;
  // Issue 使用原始标题和正文，避免把执行器提示词、生命周期说明等当成任务主题。
  const content = issue ? `${issue.title}\n\n${issue.description}` : input.prompt;
  if (!content.trim()) return null;
  // 每次生成读取持久化语言；同一次请求的 Prompt 和校验使用同一快照。
  const language = appLanguage(db);
  const context = {
    language,
    timeZone,
    titleDate,
    titlePrefix,
    currentTitle: typeof input.thread.name === "string" ? input.thread.name : "",
    projectName: project?.name ?? "",
    conversationContent: content.slice(0, 12_000)
  };
  const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot(input.cwd));
  const { piRuntimePaths, resolvePiModel } = await import("../http/piRuntime.ts");
  signal.throwIfAborted();
  const paths = piRuntimePaths(db);
  const runtime = await sdk.pi.ModelRuntime.create({
    authPath: paths.authPath, modelsPath: paths.modelsPath, refreshOnCreate: false, signal
  });
  await installPiProviderSecretOverride(runtime, paths.modelsPath, dirname(db.path), agent.model_provider);
  signal.throwIfAborted();
  const model = resolvePiModel({ find: (provider, id) => runtime.getModel(provider, id) }, agent);
  const response = await runtime.completeSimple(model, {
    systemPrompt: sessionTitleSystemPrompt(language),
    messages: [{ role: "user", content: JSON.stringify(context), timestamp: Date.now() }]
  }, { signal, maxTokens: 1024, reasoning: "minimal", toolChoice: "none", maxRetries: 0, timeoutMs: 20_000 });
  if (signal.aborted || response.stopReason !== "stop") return null;
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return parseSessionTitle(text, context);
}
