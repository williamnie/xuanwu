import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { cancelIssue, enqueueIssue } from "../../db/repositories/issueActions.ts";
import { saveTrackerCursor } from "../../db/repositories/trackerIssueSync.ts";
import { upsertExternalEvent } from "../../db/repositories/externalEvents.ts";
import { startProjectLoop, type ProjectLoopRuntime } from "../../runner/projectLoopManager.ts";
import type { GitHubConnectorConfig } from "./config.ts";
import type { GitHubIssueRepository } from "./issueSyncConfig.ts";
import { GitHubIssueClient, GitHubIssueApiError, createGitHubIssueTokenProvider, resolveGitHubWriterLogin, githubRepositoryPath, type GitHubObject } from "./issueClient.ts";
import { auditGitHubCase, fingerprint, getGitHubIssueCase, listGitHubIssueCases, observeGitHubIssue, queueGitHubWrite, updateGitHubIssueCase, type GitHubIssueCase, type GitHubIssueSource } from "./issueCaseStore.ts";
import { classifyGitHubIssue } from "./jevRouting.ts";
import { createGitHubCaseWork, readAcceptedGitHubReport } from "./issueWorkflow.ts";
import { dispatchGitHubWrites, publicGitHubSummary } from "./issueOutbox.ts";
import { syncGitHubHumanReview } from "./issueHumanBridge.ts";
import { relayNativeGitHubQuestion } from "./nativeQuestionBridge.ts";
import { interruptIssueForStatusTransition } from "../../runner/interrupt.ts";
import { isExecutorProviderId } from "../../providers/types.ts";

type RepositoryCursor = { since?: string; cooldownUntil?: string; repositoryId?: number; query?: string; etag?: string };
type RuntimeOptions = {
  config: GitHubConnectorConfig;
  stateDir: string;
  runtime: ProjectLoopRuntime;
  client?: GitHubIssueClient;
  actorLogin?: () => Promise<string>;
  now?: () => Date;
  startWork?: (issueID: number, projectID: string) => void;
  advanceDelivery?: (record: GitHubIssueCase, policy: GitHubIssueRepository, client: GitHubIssueClient) => Promise<void>;
};

export class GitHubIssueSyncRuntime {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;
  private lastRunAt = "";
  private lastError = "";
  private actorLogin = "";
  private readonly abort = new AbortController();
  private readonly client: GitHubIssueClient;
  private readonly now: () => Date;

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.client = options.client ?? new GitHubIssueClient({ apiBaseUrl: options.config.api_base_url,
      token: createGitHubIssueTokenProvider(options.config, options.stateDir), signal: this.abort.signal });
  }

  start(): void {
    if (!this.stopped || !this.options.config.issueSync.enabled) return;
    this.stopped = false;
    this.schedule(1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.active?.catch(() => {});
  }

  snapshot(): Record<string, unknown> {
    return { enabled: this.options.config.issueSync.enabled, running: this.active !== null,
      last_run_at: this.lastRunAt, last_error: this.lastError, jev_mode: this.options.config.issueSync.jev.mode,
      repositories: this.options.config.issueSync.repositories.map(policy => ({ repository: policy.repository,
        project_id: policy.projectId, intake_label: policy.intakeLabel, auto_enqueue: policy.autoEnqueue,
        ci_failure_mode: policy.ciFailureMode, ci_failure_reason: publicGitHubSummary(policy.ciFailureReason),
        cases: listGitHubIssueCases(this.options.runtime.database, policy.repository).map(record => ({
          issue_number: record.issue_number, issue_id: record.issue_id, source_revision: record.source_revision,
          stage: record.stage, external_state: record.external_state, pull_request_number: record.pull_request_number, last_error: record.last_error
        })) })) };
  }

  async sync(): Promise<void> {
    if (!this.options.config.issueSync.enabled) return;
    if (this.active) return this.active;
    this.active = this.tick().finally(() => { this.active = null; });
    return this.active;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync().catch(() => {}).finally(() => {
        if (!this.stopped) this.schedule(this.options.config.issueSync.pollIntervalSeconds * 1000);
      });
    }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.lastRunAt = this.now().toISOString();
    this.lastError = "";
    for (const policy of this.options.config.issueSync.repositories) {
      const cursor = this.readCursor(policy.repository);
      if (cursor.cooldownUntil && cursor.cooldownUntil > this.now().toISOString()) continue;
      try {
        if (!getProject(this.options.runtime.database, policy.projectId)) throw new Error("GitHub mapped project is unavailable");
        this.actorLogin ||= this.options.actorLogin ? await this.options.actorLogin() : await resolveGitHubWriterLogin(this.options.config, this.options.stateDir, this.client);
        if (!this.actorLogin) throw new Error("GitHub writer identity is unavailable");
        await this.syncRepository(policy, cursor);
      } catch (error) {
        const message = error instanceof GitHubIssueApiError ? error.message : "GitHub sync configuration or state requires attention";
        this.lastError = message;
        const seconds = error instanceof GitHubIssueApiError ? Math.max(60, error.retryAfterSeconds) : 60;
        this.writeCursor(policy.repository, { ...this.readCursor(policy.repository), cooldownUntil: new Date(this.now().getTime() + seconds * 1000).toISOString() });
        auditGitHubCase(this.options.runtime.database, policy.repository, policy.projectId, "sync_error", { error: message });
      }
    }
  }

  private async syncRepository(policy: GitHubIssueRepository, cursor: RepositoryCursor): Promise<void> {
    const db = this.options.runtime.database;
    const path = githubRepositoryPath(policy.repository);
    const repository = (await this.client.request(path)).data;
    const repositoryId = positiveID(repository.id);
    if (cursor.repositoryId && cursor.repositoryId !== repositoryId) throw new Error("GitHub repository identity changed");
    const query = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: "100", labels: policy.intakeLabel });
    if (cursor.since) query.set("since", new Date(Date.parse(cursor.since) - 60000).toISOString());
    const queryPath = `${path}/issues?${query}`;
    const first = await this.client.page(queryPath, cursor.query === queryPath ? cursor.etag : "");
    const incoming = [...first.items, ...(first.next ? await this.client.all(first.next, 19) : [])];
    const watermark = incoming.reduce((latest, item) => {
      const updated = new Date(String(item.updated_at)).toISOString();
      return updated > latest ? updated : latest;
    }, cursor.since ?? "");
    const seen = new Set<string>();
    for (const raw of incoming) {
      if (raw.pull_request) continue;
      const source = normalizeGitHubSource(repository, raw);
      seen.add(source.nodeId);
      this.ingest(source, policy);
    }
    // 已接管的 Issue 即使被移除标签或关闭，也要读取并停止后续自动动作。
    for (const record of listGitHubIssueCases(db, policy.repository)) {
      if (!seen.has(record.issue_node_id)) {
        const source = normalizeGitHubSource(repository, (await this.client.request(`${path}/issues/${record.issue_number}`)).data);
        if (source.nodeId !== record.issue_node_id) throw new Error("GitHub Issue moved; explicit remapping required");
        this.ingest(source, policy);
      }
      await this.advanceCase(getGitHubIssueCase(db, record.issue_node_id)!, policy);
    }
    const dispatch = await dispatchGitHubWrites({ database: db, client: this.client, policy, actorLogin: this.actorLogin, now: this.now });
    // 多页结果不能仅凭第一页的 304 跳过后续页，新事件可能只出现在后面的页。
    this.writeCursor(policy.repository, { repositoryId, ...(watermark ? { since: watermark } : {}), query: queryPath, etag: first.next ? "" : first.etag,
      ...(dispatch.retry ? { cooldownUntil: new Date(this.now().getTime() + Math.max(60, dispatch.retryAfterSeconds) * 1000).toISOString() } : {}) });
  }

  private ingest(source: GitHubIssueSource, policy: GitHubIssueRepository): void {
    const db = this.options.runtime.database;
    if (!getGitHubIssueCase(db, source.nodeId) && (source.state !== "open" || !source.labels.includes(policy.intakeLabel))) return;
    db.transaction(() => {
      observeGitHubIssue(db, source, policy.projectId, this.now(), policy.intakeLabel);
      upsertExternalEvent(db, { source: "github", provider: "github", external_id: `github-snapshot:${fingerprint(source)}`,
        event_type: "issue_snapshot", actor: source.author, occurred_at: source.updatedAt,
        project_id: policy.projectId, project_hint: policy.repository, trust_level: "untrusted", status: "linked",
        content: publicGitHubSummary(source.title), dedupe_key: `github:snapshot:${source.nodeId}:${fingerprint(source)}`,
        raw_json: source, normalized_message: { title: source.title, url: source.url, external_state: source.state, issue_node_id: source.nodeId } });
    }).immediate();
  }

  private async advanceCase(record: GitHubIssueCase, policy: GitHubIssueRepository): Promise<void> {
    const db = this.options.runtime.database;
    const source: GitHubIssueSource = JSON.parse(record.source_json);
    let issue = record.issue_id ? getIssue(db, record.issue_id) : null;
    if (source.state !== "open" || !source.labels.includes(policy.intakeLabel)) {
      if (source.state === "closed" && record.stage === "review" && record.pull_request_number && this.options.advanceDelivery) {
        const pr = (await this.client.request(`${githubRepositoryPath(record.repository)}/pulls/${record.pull_request_number}`)).data;
        if (pr.merged === true && (pr.head as GitHubObject)?.sha === record.head_sha) {
          await this.options.advanceDelivery(record, policy, this.client);
          return;
        }
      }
      if (issue && !["done", "failed", "cancelled"].includes(issue.status)) {
        const run = listIssueRuns(db, issue.id).at(-1);
        if (run && !run.ended_at) {
          const provider = isExecutorProviderId(run.provider) ? this.options.runtime.providers?.[run.provider] : undefined;
          if (!provider?.interrupt || !run.provider_session_id || (provider.interruptScope !== "active" && provider.interruptScope !== "session" && !run.provider_turn_id)) {
            updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { last_error: "External Issue closed or intake removed; waiting for provider interruption" });
            return;
          }
          await interruptIssueForStatusTransition(db, issue.id, "github_intake_withdrawn", this.options.runtime);
        }
        cancelIssue(db, issue.id, source.state === "closed" ? `github_closed:${source.stateReason || "unspecified"}` : "github_intake_label_removed");
        auditGitHubCase(db, record.issue_node_id, record.project_id, "work_cancelled_from_remote", { issue_id: issue.id, state_reason: source.stateReason });
      }
      if (record.stage !== "resolved") updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { stage: "paused", last_error: "" });
      return;
    }
    if (issue && record.work_source_revision !== record.source_revision && ["triage", "todo", "needs_user"].includes(issue.status)) {
      issue = cancelIssue(db, issue.id, "github_source_revision_superseded");
      auditGitHubCase(db, record.issue_node_id, record.project_id, "source_work_superseded", { issue_id: issue.id, source_revision: record.source_revision });
    }
    if (!record.issue_id || (record.work_source_revision !== record.source_revision && issue && ["done", "failed", "cancelled"].includes(issue.status))) {
      const jev = await classifyGitHubIssue({ config: this.options.config.issueSync.jev, stateDir: this.options.stateDir, title: source.title, body: source.body });
      auditGitHubCase(db, record.issue_node_id, record.project_id, "jev_routing", jev as unknown as Record<string, unknown>);
      const routingHint = jev.route === "answer_question"
        ? "快速分类建议走使用咨询路径：优先查阅使用文档并回答问题；此建议不是结论，若发现实际缺陷仍须复现与查证。"
        : jev.route === "investigate" ? "快速分类建议优先调查疑似缺陷；分类不是 Bug 证据，仍须独立确认预期行为并复现。" : "";
      record = createGitHubCaseWork(db, record, policy, "investigate", routingHint);
      this.startWork(record, policy);
      this.progress(record, "已接收，正在查证预期行为并尝试复现。", "intake");
      return;
    }
    if (!issue) return;
    if (issue.status === "in_progress") await relayNativeGitHubQuestion(this.options.runtime, record);
    if (issue.status === "triage" && policy.autoEnqueue) this.startWork(record, policy);
    if (issue.status === "needs_user") {
      await syncGitHubHumanReview({ database: db, client: this.client, record, actorLogin: this.actorLogin, runtime: this.options.runtime });
      this.progress(record, "等待补充信息或决策，具体问题见本 Issue 评论。", `waiting:${issue.updated_at}`);
      return;
    }
    if (issue.status !== "done") return;
    if (record.work_source_revision !== record.source_revision) return;
    if (record.stage === "review") {
      await this.options.advanceDelivery?.(record, policy, this.client);
      return;
    }
    if (["resolved", "paused"].includes(record.stage)) return;
    const accepted = readAcceptedGitHubReport(db, record);
    if (!accepted) {
      updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { last_error: "Accepted Work has no valid GitHub evidence report" });
      return;
    }
    record = updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { report_json: JSON.stringify(accepted.report) });
    if (record.stage === "investigate" && accepted.report.result === "bug" && policy.allowFix) {
      record = createGitHubCaseWork(db, record, policy, "repair", JSON.stringify(accepted.report));
      this.startWork(record, policy);
      this.progress(record, "已基于证据确认问题，进入修复与回归验证。", "repair");
      return;
    }
    if (record.stage === "repair") {
      if (this.options.advanceDelivery) await this.options.advanceDelivery(record, policy, this.client);
      else this.progress(record, "修复与本地验证已完成，等待交付处理。", "delivery");
      return;
    }
    const labels: Record<string, string> = { as_designed: "现有证据支持符合设计", duplicate: "关联到已有问题", question: "使用问题已调查", change_request: "属于产品变更请求", not_reproduced: "当前条件下未复现", bug: "已确认问题，等待修复授权" };
    this.progress(record, `${labels[accepted.report.result] ?? "调查完成"}。\n\n${publicGitHubSummary(accepted.report.summary)}\n\n本结论不自动关闭 Issue。`, `report:${accepted.card.fingerprint}`);
    updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { stage: "paused" });
  }

  private startWork(record: GitHubIssueCase, policy: GitHubIssueRepository): void {
    if (!policy.autoEnqueue || !record.issue_id) return;
    if (this.options.startWork) return this.options.startWork(record.issue_id, record.project_id);
    enqueueIssue(this.options.runtime.database, record.issue_id);
    startProjectLoop(this.options.runtime, record.project_id);
  }

  private progress(record: GitHubIssueCase, body: string, reason: string): void {
    queueGitHubWrite(this.options.runtime.database, record, { kind: "progress", repository: record.repository,
      issueNumber: record.issue_number, issueNodeId: record.issue_node_id, sourceRevision: record.source_revision, body },
      `progress:${record.issue_node_id}:${record.source_revision}:${reason}`);
  }

  private readCursor(repository: string): RepositoryCursor {
    const row = this.options.runtime.database.sqlite.query<{ position: string }, [string]>("select position from tracker_sync_cursors where provider='github' and scope=?").get(`issue-sync:${repository}`);
    if (!row) return {};
    return JSON.parse(row.position) as RepositoryCursor;
  }
  private writeCursor(repository: string, cursor: RepositoryCursor): void {
    saveTrackerCursor(this.options.runtime.database, { provider: "github", scope: `issue-sync:${repository}`, position: JSON.stringify(cursor) }, this.now());
  }
}

export function normalizeGitHubSource(repository: GitHubObject, raw: GitHubObject): GitHubIssueSource {
  if (raw.pull_request || typeof raw.node_id !== "string" || typeof repository.full_name !== "string" || !["open", "closed"].includes(String(raw.state))) throw new Error("Invalid GitHub Issue snapshot");
  const url = new URL(String(raw.html_url));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid GitHub Issue URL");
  const updatedAt = new Date(String(raw.updated_at)).toISOString();
  return { nodeId: raw.node_id, repositoryId: positiveID(repository.id), repository: repository.full_name.toLowerCase(),
    number: positiveID(raw.number), title: String(raw.title ?? "").slice(0, 1000), body: String(raw.body ?? "").slice(0, 65536),
    author: String((raw.user as GitHubObject)?.login ?? "unknown"), url: url.toString(), state: raw.state as "open" | "closed",
    stateReason: String(raw.state_reason ?? ""), updatedAt,
    labels: Array.isArray(raw.labels) ? raw.labels.map(label => typeof label === "string" ? label : String((label as GitHubObject).name ?? "")) : [] };
}
function positiveID(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid GitHub numeric ID"); return Number(value); }
