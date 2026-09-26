import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { readIssueDecisionProjection, reviewHumanIssue, type HumanReviewRuntime } from "../../domain/review/humanReview.ts";
import { GitHubIssueClient, githubRepositoryPath, type GitHubObject } from "./issueClient.ts";
import { auditGitHubCase, getGitHubIssueCase, queueGitHubWrite, updateGitHubIssueCase, type GitHubIssueCase } from "./issueCaseStore.ts";
import { publicGitHubSummary } from "./issueOutbox.ts";

export async function syncGitHubHumanReview(input: {
  database: RunnerDatabase; client: GitHubIssueClient; record: GitHubIssueCase;
  actorLogin: string; runtime?: HumanReviewRuntime;
}): Promise<void> {
  const { database: db, client, record } = input;
  if (!record.issue_id) return;
  const request = readIssueDecisionProjection(db, record.issue_id).request;
  if (request?.status !== "open") return;
  if (record.work_source_revision !== record.source_revision) return;
  const binding = { request_id: request.id, review_revision: request.revision, source_revision: record.source_revision };
  const body = ["玄武需要补充信息或决策：", request.question,
    request.recommendation ? `建议：${request.recommendation}` : "",
    request.consequences ? `影响：${request.consequences}` : "",
    "报告者可在本 Issue 补充事实。维护者确认后，请新建评论（不要编辑旧评论）：",
    `\`/xuanwu answer ${request.id} ${request.revision} 具体回答\``,
    request.kind === "acceptance" ? `接受当前交付：\`/xuanwu accept ${request.id} ${request.revision} 接受理由\`` : "",
    "回答只对当前问题版本有效；没有回答时会保持等待。"
  ].filter(Boolean).join("\n\n");
  db.transaction(() => {
    updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { review_binding_json: JSON.stringify(binding) });
    queueGitHubWrite(db, record, { kind: "comment", repository: record.repository, issueNumber: record.issue_number,
      issueNodeId: record.issue_node_id, sourceRevision: record.source_revision, body: publicGitHubSummary(body) }, `human:${record.issue_node_id}:${request.id}:${request.revision}`);
  }).immediate();
  const comments = await client.all<GitHubObject>(`${githubRepositoryPath(record.repository)}/issues/${record.issue_number}/comments?per_page=100`);
  for (const comment of comments.sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = Number(comment.id);
    if (!Number.isSafeInteger(id) || id <= record.comment_cursor) continue;
    const author = object(comment.user);
    const text = typeof comment.body === "string" ? comment.body : "";
    if (author.login === input.actorLogin && text.includes("<!-- xuanwu-")) { advance(id); continue; }
    if (String(comment.created_at) < request.created_at) { advance(id); continue; }
    const match = /^\/xuanwu\s+(answer|accept|reject)\s+(\S+)\s+(\d+)\s+([\s\S]+)$/.exec(text.trim());
    if (!match) {
      if (text.trim()) recordIssueEvent(db, record.issue_id, "issue.comment", {
        author: `github:${String(author.login)}`, body: publicGitHubSummary(text), source: "github_untrusted_supplement", github_comment_id: id
      });
      advance(id); continue;
    }
    const current = getGitHubIssueCase(db, record.issue_node_id);
    const currentRequest = readIssueDecisionProjection(db, record.issue_id).request;
    if (!current || current.source_revision !== binding.source_revision || currentRequest?.id !== match[2] ||
      currentRequest.revision !== Number(match[3]) || currentRequest.status !== "open") {
      auditGitHubCase(db, record.issue_node_id, record.project_id, "stale_human_reply", { comment_id: id });
      advance(id); continue;
    }
    const permission = await client.request(`${githubRepositoryPath(record.repository)}/collaborators/${encodeURIComponent(String(author.login))}/permission`);
    if (!["admin", "maintain", "write"].includes(String(permission.data.permission)) || author.type === "Bot") {
      auditGitHubCase(db, record.issue_node_id, record.project_id, "unauthorized_human_reply", { comment_id: id });
      advance(id); continue;
    }
    if ((match[1] === "accept" && currentRequest.kind !== "acceptance") || (match[1] === "answer" && currentRequest.kind === "acceptance")) {
      auditGitHubCase(db, record.issue_node_id, record.project_id, "reply_kind_mismatch", { comment_id: id });
      advance(id); continue;
    }
    if (getGitHubIssueCase(db, record.issue_node_id)?.source_revision !== binding.source_revision) throw new Error("GitHub source changed during permission check");
    // accept/reject 路径同步持久化并请求 PI；不直接改成 done，也不启动新的 Provider。
    await reviewHumanIssue(db, record.issue_id, {
      action: match[1] === "reject" ? "reject" : "accept", comment: publicGitHubSummary(match[4]!),
      review_request_id: currentRequest.id, review_revision: currentRequest.revision
    }, input.runtime);
    auditGitHubCase(db, record.issue_node_id, record.project_id, "human_reply_applied", {
      comment_id: id, author: author.login, request_id: currentRequest.id, review_revision: currentRequest.revision
    });
    advance(id);
    break;
  }
  function advance(id: number) {
    updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { comment_cursor: id });
  }
}

function object(value: unknown): GitHubObject { return value && typeof value === "object" && !Array.isArray(value) ? value as GitHubObject : {}; }
