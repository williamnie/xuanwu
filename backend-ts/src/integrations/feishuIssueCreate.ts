import { createExternalLink, listExternalLinksByExternal, type ExternalLinkRecord } from "../db/repositories/externalLinks.ts";
import { getExternalEvent, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { createImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import { ISSUE_TITLE_MAX_RUNES, createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getProject, type Project, ProjectNotFoundError } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createRepoContextPack } from "../pi/repoContextPack.ts";
import { renderRepoContextPackIssueMarkdown } from "../pi/issueProposalContext.ts";
import { redactSensitiveText } from "../util/redact.ts";

type JsonObject = Record<string, unknown>;

export type FeishuIssueCreateInput = {
  acceptance_criteria?: unknown;
  project_id?: unknown;
  validation?: unknown;
};

export type FeishuIssueCreateResult = {
  created: boolean;
  external_link: ExternalLinkRecord;
  issue: Issue;
  issue_id: number;
};

export function createFeishuIssueFromExternalEvent(
  db: RunnerDatabase,
  eventID: number,
  input: FeishuIssueCreateInput = {}
): FeishuIssueCreateResult {
  const write = db.transaction(() => {
    const event = mustFeishuEvent(db, eventID);
    const existing = existingLinkedIssue(db, event);
    if (existing) return existing;
    const project = mustTargetProject(db, event, input);
    const issue = createIssue(db, issueInput(event, project, input));
    const link = createExternalLink(db, linkInput(event, issue.id, project.id));
    createImReplyDraft(db, replyDraftInput(event, issue.id));
    return { created: true, external_link: link, issue, issue_id: issue.id };
  });
  return write.immediate();
}

function mustFeishuEvent(db: RunnerDatabase, eventID: number): ExternalEventRecord {
  const event = getExternalEvent(db, eventID);
  if (!event) throw new Error("external event not found");
  if (event.source !== "feishu") throw new Error("only feishu external events can create runner issues");
  return event;
}

function existingLinkedIssue(db: RunnerDatabase, event: ExternalEventRecord): FeishuIssueCreateResult | null {
  const link = listExternalLinksByExternal(db, {
    externalID: event.external_id,
    externalType: "feishu_message",
    source: event.source
  }).find((item) => item.external_event_id === event.id && item.relationship === "created_issue");
  const issue = link ? getIssue(db, link.issue_id) : null;
  return issue && link ? { created: false, external_link: link, issue, issue_id: issue.id } : null;
}

function mustTargetProject(db: RunnerDatabase, event: ExternalEventRecord, input: FeishuIssueCreateInput): Project {
  const projectID = firstText(input.project_id, event.project_id, event.project_hint, attentionProjectID(event.summary));
  if (projectID === "") throw new Error("project_id is required to create issue from external event");
  const project = getProject(db, projectID);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function issueInput(event: ExternalEventRecord, project: Project, input: FeishuIssueCreateInput) {
  return {
    description: issueDescription(event, project, input),
    project_id: project.id,
    source_excerpt: safeText(event.content),
    source_session_id: sourceSessionID(event),
    source_turn_id: messageID(event),
    status: "triage",
    title: issueTitle(event)
  };
}

function issueDescription(event: ExternalEventRecord, project: Project, input: FeishuIssueCreateInput): string {
  const pack = createRepoContextPack({
    acceptance_criteria: textList(input.acceptance_criteria, defaultAcceptance()),
    confidence: "low",
    evidence: [{
      confidence: "high",
      message_id: messageID(event),
      reason: "飞书消息触发创建 runner issue",
      source_kind: "message",
      summary: safeText(event.content)
    }],
    intent: safeText(event.content),
    project: { cwd: "", id: project.id, name: project.name },
    proposed_changes: ["executor 复核仓库代码与运行态后，按原始消息需求做最小直接修改。"],
    source: { channel: "feishu", kind: "im", message_id: messageID(event) },
    validation: textList(input.validation, defaultValidation())
  });
  return [externalSourceSection(event), renderRepoContextPackIssueMarkdown(pack, { description: event.content })].join("\n\n");
}

function externalSourceSection(event: ExternalEventRecord): string {
  const message = normalizedMessage(event);
  return [
    "## 外部来源",
    `- Source: ${event.source}`,
    `- Message ID: ${messageID(event)}`,
    `- Sender: ${safeText(event.actor) || "(unknown)"}`,
    `- Chat: ${safeText(message.chat_id)}${message.chat_type ? ` (${safeText(message.chat_type)})` : ""}`,
    `- Thread: ${threadID(event) || "(none)"}`,
    `- Raw payload ref: ${safeText(event.raw_payload_ref) || "(none)"}`,
    "",
    "### 原始消息",
    safeText(event.content) || "(empty)",
    "",
    "### 附件 metadata",
    ...attachmentLines(message.attachments)
  ].join("\n");
}

function linkInput(event: ExternalEventRecord, issueID: number, projectID: string) {
  return {
    conversation_id: threadID(event) || chatID(event),
    external_event_id: event.id,
    external_type: "feishu_message",
    issue_id: issueID,
    project_id: projectID,
    relationship: "created_issue"
  };
}

function replyDraftInput(event: ExternalEventRecord, issueID: number) {
  return {
    content: `已记录为 runner issue #${issueID}，等待确认是否开始执行。`,
    created_by: "pi",
    external_event_id: event.id,
    issue_id: issueID,
    risk: "low",
    source: event.source,
    status: "pending",
    target_chat_id: chatID(event),
    target_message_id: messageID(event),
    target_thread_id: threadID(event)
  };
}

function issueTitle(event: ExternalEventRecord): string {
  const prefix = "飞书: ";
  return truncateRunes(`${prefix}${singleLine(safeText(event.content)) || messageID(event)}`, ISSUE_TITLE_MAX_RUNES);
}

function sourceSessionID(event: ExternalEventRecord): string {
  return `feishu:${threadID(event) || chatID(event) || messageID(event)}`;
}

function attachmentLines(value: unknown): string[] {
  const attachments = Array.isArray(value) ? value.map(attachmentSummary).filter(Boolean) : [];
  return attachments.length > 0 ? attachments.map((item, index) => `${index + 1}. ${item}`) : ["- (none)"];
}

function attachmentSummary(value: unknown): string {
  const item = objectValue(value);
  const parts = [item.type, item.name, item.mime_type, numberText(item.size)].map(safeText).filter(Boolean);
  return parts.join(" / ");
}

function normalizedMessage(event: ExternalEventRecord): JsonObject {
  return objectValue(event.normalized_message);
}

function attentionProjectID(summary: JsonObject): string {
  return safeText(objectValue(summary.attention_decision).project_id);
}

function messageID(event: ExternalEventRecord): string {
  return safeText(normalizedMessage(event).message_id) || safeText(event.external_id);
}

function chatID(event: ExternalEventRecord): string {
  return safeText(normalizedMessage(event).chat_id);
}

function threadID(event: ExternalEventRecord): string {
  const message = normalizedMessage(event);
  return safeText(message.thread_id) || safeText(message.root_id);
}

function defaultAcceptance(): string[] {
  return [
    "飞书消息描述的需求被 executor 复核并实现。",
    "runner issue 保持 triage，是否执行由用户或后续 policy 决定。"
  ];
}

function defaultValidation(): string[] {
  return ["executor 根据实际改动选择最小必要测试，并在完成前报告验证结果。"];
}

function textList(value: unknown, fallback: string[]): string[] {
  const list = Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
  return list.length > 0 ? list : fallback;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value} bytes` : "";
}

function singleLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" / ");
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}

function firstText(...values: unknown[]): string {
  return values.map(safeText).find(Boolean) ?? "";
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  return runes.length <= maxRunes ? value : `${runes.slice(0, maxRunes - 1).join("")}…`;
}
