import type { Project } from "../db/repositories/projects.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  REPO_CONTEXT_PACK_NOTICE,
  createRepoContextPack,
  type RepoContextEvidenceItem,
  type RepoContextPack,
  type RepoContextPackInput,
  type RepoContextRelevantFile
} from "./repoContextPack.ts";

export type IssueProposalContextFields = {
  acceptance_criteria?: unknown;
  context_pack?: unknown;
  evidence?: unknown;
  open_questions?: unknown;
  proposed_changes?: unknown;
  relevant_files?: unknown;
  validation?: unknown;
};

export type IssueProposalContextRenderOptions = { description?: string };
export type IssueProposalContextProject = { project?: Project; projectID: string };

export function renderIssueCreateProposalDescription(
  input: IssueProposalContextFields & { description?: unknown; title?: unknown },
  context: IssueProposalContextProject
): string {
  const description = textValue(input.description);
  if (!hasRepoContextFields(input)) return description;
  const pack = createIssueProposalContextPack(input, context);
  return renderRepoContextPackIssueMarkdown(pack, { description });
}

export function renderRepoContextPackIssueMarkdown(
  pack: RepoContextPack,
  options: IssueProposalContextRenderOptions = {}
): string {
  return [
    section("需求理解", requirementLines(pack, options.description)),
    section("相关证据", evidenceLines(pack)),
    section("建议改动", numbered(pack.proposed_changes)),
    section("验收标准", numbered(pack.acceptance_criteria)),
    section("验证建议", numbered(pack.validation)),
    section("未确认问题", numbered(pack.open_questions))
  ].join("\n").trim();
}

function createIssueProposalContextPack(
  input: IssueProposalContextFields & { description?: unknown; title?: unknown },
  context: IssueProposalContextProject
): RepoContextPack {
  const raw = objectValue(input.context_pack);
  return createRepoContextPack({
    ...raw,
    acceptance_criteria: mergeArray(raw.acceptance_criteria, input.acceptance_criteria),
    evidence: mergeArray(raw.evidence, input.evidence) as RepoContextPackInput["evidence"],
    intent: contextIntent(raw, input),
    open_questions: mergeArray(raw.open_questions, input.open_questions),
    project: contextProject(raw.project, context),
    proposed_changes: mergeArray(raw.proposed_changes, input.proposed_changes),
    relevant_files: mergeArray(raw.relevant_files, input.relevant_files) as RepoContextPackInput["relevant_files"],
    validation: mergeArray(raw.validation, input.validation)
  });
}

function hasRepoContextFields(input: IssueProposalContextFields): boolean {
  return isPlainObject(input.context_pack) || [
    input.acceptance_criteria,
    input.evidence,
    input.open_questions,
    input.proposed_changes,
    input.relevant_files,
    input.validation
  ].some(hasArrayItems);
}

function contextIntent(
  raw: Record<string, unknown>,
  input: { description?: unknown; title?: unknown }
): string {
  return textValue(raw.intent) || textValue(input.description) || textValue(input.title) || "Issue proposal";
}

function contextProject(
  rawProject: unknown,
  context: IssueProposalContextProject
): RepoContextPackInput["project"] {
  const raw = objectValue(rawProject);
  return {
    cwd: context.project?.cwd || textValue(raw.cwd),
    id: context.projectID || textValue(raw.id),
    name: context.project?.name || textValue(raw.name)
  };
}

function requirementLines(pack: RepoContextPack, description: unknown): string[] {
  const original = cleanText(description);
  return [
    original && `- 原始描述：${singleLine(original)}`,
    `- PI 理解：${pack.intent || "(未提供)"}`,
    `- 项目：${projectLabel(pack.project)}`,
    `- 置信度：${pack.confidence}；生成时间：${pack.generated_at}`,
    `- 来源：${sourceLabel(pack.source)}`,
    `> ${REPO_CONTEXT_PACK_NOTICE}`
  ].filter(Boolean) as string[];
}

function evidenceLines(pack: RepoContextPack): string[] {
  return [
    ...pack.evidence.map(evidenceLine),
    ...pack.relevant_files.map(relevantFileLine)
  ].filter(Boolean);
}

function evidenceLine(item: RepoContextEvidenceItem, index: number): string {
  const locator = evidenceLocator(item);
  const detail = [item.reason, item.summary, item.excerpt].filter(Boolean).map(singleLine).join("；");
  return `${index + 1}. [${item.source_kind}/${item.confidence}] ${locator}${detail || "相关上下文"}`;
}

function relevantFileLine(item: RepoContextRelevantFile, index: number): string {
  const symbols = item.symbols.length > 0 ? `；symbols=${item.symbols.join(", ")}` : "";
  return `F${index + 1}. 文件 \`${item.path}\`：${item.reason || "相关文件"}${symbols}`;
}

function evidenceLocator(item: RepoContextEvidenceItem): string {
  const locators = [
    item.path && `path=\`${item.path}\``,
    item.issue_id > 0 && `issue=#${item.issue_id}`,
    item.session_key && `session=${item.session_key}`,
    item.message_id && `message=${item.message_id}`
  ].filter(Boolean);
  return locators.length > 0 ? `${locators.join(" ")} - ` : "";
}

function numbered(items: string[]): string[] {
  return items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`) : [];
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...(lines.length > 0 ? lines : ["- (none)"]), ""].join("\n");
}

function mergeArray(primary: unknown, extra: unknown): unknown[] {
  return [...arrayValue(primary), ...arrayValue(extra)];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function projectLabel(project: RepoContextPack["project"]): string {
  return [project.id, project.name, project.cwd].filter(Boolean).join(" / ") || "(未指定)";
}

function sourceLabel(source: RepoContextPack["source"]): string {
  return [source.kind, source.channel, source.message_id, source.session_key].filter(Boolean).join(" / ") || "(未指定)";
}

function singleLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" / ");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: unknown): string {
  return redactSensitiveText(textValue(value)).trim();
}
