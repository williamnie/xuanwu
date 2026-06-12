import { redactSensitiveText } from "../util/redact.ts";

export type RepoContextPackConfidence = "low" | "medium" | "high";
export type RepoContextEvidenceSourceKind = "code" | "doc" | "issue" | "memory" | "message" | "project" | "session" | "tool" | "unknown";
export type RepoContextPackSourceKind = "api" | "im" | "issue" | "manual" | "runner" | "session";

export type RepoContextPackProject = { cwd: string; id: string; name: string };
export type RepoContextPackSource = {
  channel: string;
  kind: RepoContextPackSourceKind;
  message_id: string;
  session_key: string;
};
export type RepoContextEvidenceItem = {
  confidence: RepoContextPackConfidence;
  excerpt: string;
  issue_id: number;
  message_id: string;
  path: string;
  reason: string;
  session_key: string;
  source_kind: RepoContextEvidenceSourceKind;
  summary: string;
};
export type RepoContextRelevantFile = { path: string; reason: string; symbols: string[] };
export type RepoContextPack = {
  acceptance_criteria: string[];
  confidence: RepoContextPackConfidence;
  evidence: RepoContextEvidenceItem[];
  generated_at: string;
  intent: string;
  kind: "repo_context_pack";
  open_questions: string[];
  project: RepoContextPackProject;
  proposed_changes: string[];
  relevant_files: RepoContextRelevantFile[];
  source: RepoContextPackSource;
  validation: string[];
  version: 1;
};
export type RepoContextPackInput = Omit<Partial<RepoContextPack>,
  "evidence" | "generated_at" | "intent" | "kind" | "project" | "relevant_files" | "source" | "version"
> & {
  evidence?: Partial<RepoContextEvidenceItem>[];
  intent: string;
  project: { cwd?: string; id: string; name?: string };
  relevant_files?: Partial<RepoContextRelevantFile>[];
  source?: Partial<RepoContextPackSource>;
};

export const REPO_CONTEXT_PACK_VERSION = 1;
export const REPO_CONTEXT_PACK_NOTICE =
  "PI repo_context_pack 是只读代码/上下文后的初步上下文，不是 executor 的强制指令；executor 需要复核运行态和代码后再实现、测试、提交。";

export function createRepoContextPack(input: RepoContextPackInput, options: { now?: Date | string } = {}): RepoContextPack {
  return {
    kind: "repo_context_pack",
    version: REPO_CONTEXT_PACK_VERSION,
    intent: cleanText(input.intent),
    project: normalizeProject(input.project),
    evidence: cleanEvidenceList(input.evidence),
    relevant_files: cleanRelevantFiles(input.relevant_files),
    proposed_changes: cleanTextList(input.proposed_changes),
    acceptance_criteria: cleanTextList(input.acceptance_criteria),
    validation: cleanTextList(input.validation),
    open_questions: cleanTextList(input.open_questions),
    confidence: normalizeConfidence(input.confidence),
    generated_at: generatedAt(options.now),
    source: normalizeSource(input.source)
  };
}

export function renderRepoContextPack(pack: RepoContextPack): string {
  return [
    "## PI repo_context_pack",
    `> ${REPO_CONTEXT_PACK_NOTICE}`,
    "",
    `- Intent: ${pack.intent || "(not specified)"}`,
    `- Project: ${projectLabel(pack.project)}`,
    `- Confidence: ${pack.confidence}`,
    `- Generated at: ${pack.generated_at}`,
    `- Source: ${sourceLabel(pack.source)}`,
    "",
    renderEvidence(pack.evidence),
    renderFiles(pack.relevant_files),
    renderList("Proposed changes", pack.proposed_changes),
    renderList("Acceptance criteria", pack.acceptance_criteria),
    renderList("Suggested validation", pack.validation),
    renderList("Open questions", pack.open_questions)
  ].filter(Boolean).join("\n");
}

function normalizeProject(project: RepoContextPackInput["project"]): RepoContextPackProject {
  return { cwd: cleanText(project.cwd), id: cleanText(project.id), name: cleanText(project.name) };
}

function normalizeSource(source: RepoContextPackInput["source"] = {}): RepoContextPackSource {
  return {
    channel: cleanText(source.channel),
    kind: normalizeSourceKind(source.kind),
    message_id: cleanText(source.message_id),
    session_key: cleanText(source.session_key)
  };
}

function cleanEvidenceList(items: RepoContextPackInput["evidence"] = []): RepoContextEvidenceItem[] {
  return items.map(cleanEvidenceItem).filter(hasEvidenceValue);
}

function cleanEvidenceItem(item: Partial<RepoContextEvidenceItem>): RepoContextEvidenceItem {
  return {
    source_kind: normalizeEvidenceKind(item.source_kind),
    path: cleanText(item.path),
    issue_id: positiveInteger(item.issue_id),
    session_key: cleanText(item.session_key),
    message_id: cleanText(item.message_id),
    reason: cleanText(item.reason),
    excerpt: cleanText(item.excerpt),
    summary: cleanText(item.summary),
    confidence: normalizeConfidence(item.confidence)
  };
}

function hasEvidenceValue(item: RepoContextEvidenceItem): boolean {
  return [item.path, item.session_key, item.message_id, item.reason, item.excerpt, item.summary].some(Boolean)
    || item.issue_id > 0;
}

function cleanRelevantFiles(items: RepoContextPackInput["relevant_files"] = []): RepoContextRelevantFile[] {
  return items.map((item) => ({
    path: cleanText(item.path),
    reason: cleanText(item.reason),
    symbols: cleanTextList(item.symbols)
  })).filter((item) => item.path !== "");
}

function renderEvidence(items: RepoContextEvidenceItem[]): string {
  if (items.length === 0) return renderEmptySection("Evidence");
  const lines = items.map((item, index) => `${index + 1}. ${evidenceLabel(item)}`);
  return ["### Evidence", ...lines, ""].join("\n");
}

function renderFiles(items: RepoContextRelevantFile[]): string {
  if (items.length === 0) return renderEmptySection("Relevant files");
  const lines = items.map((item, index) => `${index + 1}. \`${item.path}\` - ${item.reason || "related"}${symbolSuffix(item)}`);
  return ["### Relevant files", ...lines, ""].join("\n");
}

function renderList(title: string, items: string[]): string {
  if (items.length === 0) return renderEmptySection(title);
  return [`### ${title}`, ...items.map((item, index) => `${index + 1}. ${item}`), ""].join("\n");
}

function evidenceLabel(item: RepoContextEvidenceItem): string {
  const locators = [item.path && `path=\`${item.path}\``, item.issue_id > 0 && `issue=#${item.issue_id}`,
    item.session_key && `session=${item.session_key}`, item.message_id && `message=${item.message_id}`].filter(Boolean);
  const details = [item.reason, item.summary, item.excerpt].filter(Boolean).join(" — ");
  return `[${item.source_kind}/${item.confidence}] ${locators.join(" ")}${locators.length ? " - " : ""}${details || "related context"}`;
}

function symbolSuffix(item: RepoContextRelevantFile): string {
  return item.symbols.length === 0 ? "" : ` (symbols: ${item.symbols.join(", ")})`;
}

function projectLabel(project: RepoContextPackProject): string {
  return [project.id, project.name, project.cwd].filter(Boolean).join(" / ") || "(not specified)";
}

function sourceLabel(source: RepoContextPackSource): string {
  return [source.kind, source.channel, source.message_id, source.session_key].filter(Boolean).join(" / ");
}

function renderEmptySection(title: string): string {
  return [`### ${title}`, "- (none)", ""].join("\n");
}

function normalizeConfidence(value: unknown): RepoContextPackConfidence {
  return value === "low" || value === "high" || value === "medium" ? value : "medium";
}

function normalizeEvidenceKind(value: unknown): RepoContextEvidenceSourceKind {
  const allowed = ["code", "doc", "issue", "memory", "message", "project", "session", "tool", "unknown"];
  return typeof value === "string" && allowed.includes(value) ? value as RepoContextEvidenceSourceKind : "unknown";
}

function normalizeSourceKind(value: unknown): RepoContextPackSourceKind {
  const allowed = ["api", "im", "issue", "manual", "runner", "session"];
  return typeof value === "string" && allowed.includes(value) ? value as RepoContextPackSourceKind : "manual";
}

function cleanTextList(items: unknown): string[] {
  return Array.isArray(items) ? items.map(cleanText).filter(Boolean) : [];
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactSecretAssignmentLines(redactSensitiveText(value)).trim();
}

function redactSecretAssignmentLines(value: string): string {
  return value.split(/\r?\n/).map((line) => {
    return /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)\s*[:=]/i.test(line) ? "[redacted sensitive line]" : line;
  }).join("\n");
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function generatedAt(now: Date | string | undefined): string {
  if (now instanceof Date) return now.toISOString();
  return cleanText(now) || new Date().toISOString();
}
