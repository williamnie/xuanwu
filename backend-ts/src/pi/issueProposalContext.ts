import { issueBodySections, renderIssueBodySections, type IssueBodySection } from "./issuePlanningBody.ts";
import type { Project } from "../db/repositories/projects.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
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
  const original = cleanText(options.description);
  const sections = issueBodySections(original);
  const compact = sections.some(({ heading }) => /^(一句话目标|Goal)$/i.test(heading));
  const english = sections.some(({ heading }) => /^Goal$/i.test(heading));
  const body: IssueBodySection[] = compact ? sections : [];
  const add = (zh: string, en: string, lines: string[]) => {
    const found = body.find(({ heading }) => heading === zh || heading.toLowerCase() === en.toLowerCase());
    if (found) {
      const existing = new Set(found.body.split("\n").map(normalizeListLine));
      const missing = lines.filter((line) => line && (line.includes("\n")
        ? !found.body.includes(line) : !existing.has(normalizeListLine(line))));
      if (missing.length) found.body = [found.body, ...missing].filter(Boolean).join("\n");
    } else if (lines.length) body.push({ heading: english ? en : zh, body: lines.join("\n") });
  };
  if (!compact) add("一句话目标", "Goal", [pack.intent]);
  add("做什么", "Scope", [...(!compact && original ? [original] : []), ...numbered(pack.proposed_changes)]);
  add("验收标准", "Acceptance criteria", numbered(pack.acceptance_criteria));
  const manual = body.some(({ heading }) => /^(人工验收|Manual acceptance)$/i.test(heading));
  add(manual ? "人工验收" : "自动验证", manual ? "Manual acceptance" : "Automated validation", numbered(pack.validation));
  if (!body.some(({ heading }) => /^(依赖|dependencies?)$/i.test(heading))) {
    add("依赖", "Dependencies", [english ? "- None" : "- 无"]);
  }
  add("相关证据", "Evidence", evidenceLines(pack));
  add("未确认问题", "Open questions", numbered(pack.open_questions));
  return renderIssueBodySections(body);
}

function createIssueProposalContextPack(
  input: IssueProposalContextFields & { description?: unknown; title?: unknown },
  context: IssueProposalContextProject
): RepoContextPack {
  const raw = objectValue(input.context_pack);
  assertSupportedContextPackKeys(raw);
  return createRepoContextPack({
    ...raw,
    acceptance_criteria: normalizeTextList(mergeArrays(raw.acceptance_criteria, raw["验收标准"], input.acceptance_criteria)),
    evidence: normalizeEvidence(mergeArrays(raw.evidence, raw["相关证据"], input.evidence)),
    intent: contextIntent(raw, input),
    open_questions: normalizeTextList(mergeArrays(raw.open_questions, raw["未确认问题"], input.open_questions)),
    project: contextProject(raw.project, context),
    proposed_changes: normalizeTextList(mergeArrays(raw.proposed_changes, raw["建议改动"], input.proposed_changes)),
    relevant_files: mergeArrays(raw.relevant_files, raw["相关文件"], input.relevant_files) as RepoContextPackInput["relevant_files"],
    validation: normalizeTextList(mergeArrays(raw.validation, raw["验证建议"], input.validation))
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
  return textValue(raw.intent) || textValue(raw["需求理解"]) || textValue(input.description) || textValue(input.title) || "Issue proposal";
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

function normalizeListLine(line: string): string {
  return line.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
}

function evidenceLines(pack: RepoContextPack): string[] {
  const source = [pack.source.session_key && `session=${pack.source.session_key}`,
    pack.source.message_id && `message=${pack.source.message_id}`].filter(Boolean).join(" ");
  return [
    source && `- 来源：${source}`,
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

function mergeArrays(...values: unknown[]): unknown[] {
  return values.flatMap(arrayValue);
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

const CONTEXT_PACK_KEYS = new Set([
  "acceptance_criteria", "confidence", "evidence", "generated_at", "intent", "kind", "open_questions",
  "project", "proposed_changes", "relevant_files", "source", "validation", "version",
  "需求理解", "相关证据", "相关文件", "建议改动", "验收标准", "验证建议", "未确认问题"
]);

function assertSupportedContextPackKeys(raw: Record<string, unknown>): void {
  const unsupported = Object.keys(raw).filter((key) => !CONTEXT_PACK_KEYS.has(key));
  if (unsupported.length > 0) throw new Error(`context_pack contains unsupported fields: ${unsupported.join(", ")}`);
}

function normalizeEvidence(items: unknown[]): RepoContextPackInput["evidence"] {
  return items.map((item) => typeof item === "string"
    ? { source_kind: "message" as const, summary: item }
    : objectValue(item));
}

function normalizeTextList(items: unknown[]): string[] {
  return [...new Set(items.map(textValue).filter(Boolean))];
}

function singleLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" / ");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: unknown): string {
  return redactSensitiveText(textValue(value)).split(/\r?\n/).map((line) =>
    /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)\s*[:=]/i.test(line)
      ? "[redacted sensitive line]" : line
  ).join("\n").trim();
}
