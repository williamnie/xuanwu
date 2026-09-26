import type { RunnerDatabase } from "../../db/database.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { GitHubIssueRepository } from "./issueSyncConfig.ts";
import { claimGitHubWrite, finishGitHubWrite, getGitHubIssueCase, fingerprint, updateGitHubIssueCase, type GitHubIssueCase, type GitHubWrite } from "./issueCaseStore.ts";
import { GitHubIssueApiError, GitHubIssueClient, githubRepositoryPath, type GitHubObject } from "./issueClient.ts";

export function publicGitHubSummary(text: string): string {
  return redactSensitiveText(text)
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)[^\s`<>"']+/g, "[local path]")
    .replace(/@(?=[a-zA-Z0-9])/g, "＠")
    .slice(0, 10000);
}

export async function dispatchGitHubWrites(input: {
  database: RunnerDatabase;
  client: GitHubIssueClient;
  policy: GitHubIssueRepository;
  actorLogin: string;
  now?: () => Date;
  limit?: number;
}): Promise<{ sent: number; failed: number; retry: number; retryAfterSeconds: number }> {
  const result = { sent: 0, failed: 0, retry: 0, retryAfterSeconds: 0 };
  const now = input.now ?? (() => new Date());
  // 保持逐条发送，避免 API 次级限流；每个 tick 限定写入数量。
  for (let i = 0; i < (input.limit ?? 3); i++) {
    const write = claimGitHubWrite(input.database, input.policy.repository, now());
    if (!write) break;
    try {
      const record = getGitHubIssueCase(input.database, write.command.issueNodeId);
      if (!record || record.source_revision !== write.command.sourceRevision || record.repository !== write.command.repository ||
        record.issue_number !== write.command.issueNumber || record.project_id !== input.policy.projectId) throw new Error("stale_or_unmapped_write");
      if (write.command.kind === "close" && (!input.policy.closeOnMerge || record.stage !== "resolved" || !record.pull_request_number)) throw new Error("close_policy_not_satisfied");
      const receipt = await sendWrite(input.client, write, input.actorLogin, record, input.policy.intakeLabel);
      if (finishGitHubWrite(input.database, write, { receipt }, now())) result.sent++;
    } catch (error) {
      const retryable = error instanceof GitHubIssueApiError && error.retryable;
      const retrySeconds = retryable ? Math.max(error.retryAfterSeconds, Math.min(3600, 15 * 2 ** write.attempt)) : undefined;
      finishGitHubWrite(input.database, write, { error: error instanceof GitHubIssueApiError ? error.message : "GitHub write blocked by policy or invalid state", retrySeconds }, now());
      if (retrySeconds !== undefined && write.attempt < 8) result.retry++; else result.failed++;
      result.retryAfterSeconds = Math.max(result.retryAfterSeconds, retrySeconds ?? 0);
      const record = getGitHubIssueCase(input.database, write.command.issueNodeId);
      if (record) updateGitHubIssueCase(input.database, record.issue_node_id, record.source_revision, { last_error: error instanceof GitHubIssueApiError ? error.message : "GitHub write blocked by policy or invalid state" });
      // 单次 API 故障之后立即停止整仓库写入；不能用后续任务绕过 cooldown。
      if (error instanceof GitHubIssueApiError) break;
    }
  }
  return result;
}

async function sendWrite(client: GitHubIssueClient, write: GitHubWrite, actorLogin: string, record: GitHubIssueCase, intakeLabel: string): Promise<Record<string, unknown>> {
  if (!actorLogin) throw new Error("GitHub writer identity is unavailable");
  const command = write.command;
  const repo = githubRepositoryPath(command.repository);
  const path = `${repo}/issues/${command.issueNumber}`;
  // 重新读取身份，防止 Issue 转移/编号复用时写到错误目标。
  const remote = await client.request(path);
  if (remote.data.node_id !== command.issueNodeId) throw new Error("GitHub issue identity changed");
  if (!Array.isArray(remote.data.labels) || !remote.data.labels.some(label => (typeof label === "string" ? label : object(label).name) === intakeLabel)) throw new Error("GitHub intake authorization was removed");
  if (fingerprint({ title: String(remote.data.title ?? "").slice(0, 1000), body: String(remote.data.body ?? "").slice(0, 65536) }) !== record.source_fingerprint) throw new Error("GitHub Issue content changed before write");
  if (command.kind === "close") {
    const pr = (await client.request(`${repo}/pulls/${record.pull_request_number}`)).data;
    if (pr.merged !== true || object(pr.head).sha !== record.head_sha) throw new Error("GitHub merge evidence changed before closure");
    if (remote.data.state === "closed") return { external_state: "closed", replayed: true };
    const response = await client.request(path, { method: "PATCH", body: { state: "closed", state_reason: command.stateReason ?? "completed" } });
    if (response.data.state !== "closed") throw new Error("GitHub did not close issue");
    return { external_state: "closed", request_ref: response.headers.get("x-github-request-id") };
  }
  const marker = command.kind === "progress" ? `<!-- xuanwu-progress:${command.issueNodeId} -->` : write.marker;
  const body = `${publicGitHubSummary(command.body)}\n\n${marker}`;
  const comments = await client.all<GitHubObject>(`${path}/comments?per_page=100`);
  const existing = comments.find(comment => object(comment.user).login === actorLogin && String(comment.body ?? "").includes(marker));
  if (existing?.body === body) return { comment_id: existing.id, url: existing.html_url, replayed: true };
  const response = existing
    ? await client.request(`${repo}/issues/comments/${positiveID(existing.id)}`, { method: "PATCH", body: { body } })
    : await client.request(`${path}/comments`, { method: "POST", body: { body } });
  if (!Number.isSafeInteger(response.data.id) || object(response.data.user).login !== actorLogin) throw new Error("GitHub comment receipt identity mismatch");
  return { comment_id: response.data.id, url: response.data.html_url, request_ref: response.headers.get("x-github-request-id"), replayed: !!existing };
}

function object(value: unknown): GitHubObject { return value && typeof value === "object" && !Array.isArray(value) ? value as GitHubObject : {}; }
function positiveID(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid GitHub object ID"); return Number(value); }
