import { dirname } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import { localSettingsPath, readLocalSettingsFile, updateLocalSettingsFile, type RunnerLocalSettings } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject, listProjects } from "../db/repositories/projects.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { buildGitHubConnectorConfig, type GitHubConnectorConfig } from "../integrations/github/config.ts";
import { buildGitHubIssueSyncConfig, type GitHubIssueSyncConfig } from "../integrations/github/issueSyncConfig.ts";
import { fingerprint, type GitHubIssueCase } from "../integrations/github/issueCaseStore.ts";
import { GitHubIssueApiError, GitHubIssueClient, createGitHubIssueTokenProvider, githubRepositoryPath } from "../integrations/github/issueClient.ts";
import { publicGitHubSummary } from "../integrations/github/issueOutbox.ts";
import type { GitHubIssueSyncRuntime } from "../integrations/github/issueSyncRuntime.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type Context = {
  config?: RunnerConfig;
  database: RunnerDatabase;
  githubIssueSync?: GitHubIssueSyncRuntime;
  clientFactory?: (config: GitHubConnectorConfig) => GitHubIssueClient;
};
const SETTINGS_FIELDS = ["enabled", "pollIntervalSeconds", "auth", "repositories"];
const REPOSITORY_FIELDS = ["repository", "projectId", "intakeLabel", "autoEnqueue", "allowFix", "allowPullRequest", "closeOnMerge", "baseBranch", "ciFailureMode", "ciFailureReason"];

export function registerGitHubSettingsRoutes(router: Router, context: Context): void {
  router.get("/api/integrations/trackers/github/settings", async () => json(await readSettings(context)));
  router.put("/api/integrations/trackers/github/settings", async request => {
    const body = object(await parseJsonBody(request));
    only(body, ["revision", "settings"]);
    const next = submittedSettings(context, body.settings);
    try {
      await updateLocalSettingsFile(path(context), current => {
        checkRevision(body.revision, current);
        checkMappings(context, next);
        const github = current.integrations?.github ?? {};
        return { ...current, integrations: { ...current.integrations, github: { ...github,
          issueSync: { ...object(github.issueSync ?? {}), ...next } } } };
      });
    } catch (error) { throw settingsError(error); }
    audit(context, "saved", next);
    return json(await readSettings(context));
  });
  router.post("/api/integrations/trackers/github/reload", async request => {
    const body = object(await parseJsonBody(request));
    only(body, ["revision"]);
    // 共用设置更新锁，确保应用时校验的版本不会被另一个页面并发保存替换。
    try {
      await updateLocalSettingsFile(path(context), current => {
        checkRevision(body.revision, current);
        const next = savedSettings(context, current);
        checkMappings(context, next);
        if (!context.githubIssueSync || !context.config) throw new HttpError(503, "runtime_unavailable：配置已保存，需启动或重启服务后生效");
        const config = { ...context.config.integrations.github, issueSync: next };
        try { context.githubIssueSync.reload(config); }
        catch { throw new HttpError(409, "reload_failed：配置已保存但未应用；轮询可能正在运行，请稍后重试。现有运行配置保持不变"); }
        context.config.integrations.github = config;
        audit(context, "applied", next);
        return current;
      });
    } catch (error) { throw settingsError(error); }
    return json(await readSettings(context));
  });
  router.post("/api/integrations/trackers/github/test", async request => {
    const body = object(await parseJsonBody(request));
    only(body, ["settings"]);
    const settings = submittedSettings(context, body.settings);
    const config = { ...connector(context), issueSync: settings };
    const client = context.clientFactory?.(config) ?? new GitHubIssueClient({ apiBaseUrl: config.api_base_url,
      token: createGitHubIssueTokenProvider(config, stateDir(context)) });
    // 只读探测，不调用 sync、不创建 Work、不写评论，也不保存草稿。
    const repositories = [];
    for (const policy of settings.repositories) repositories.push(await probeRepository(client, policy));
    return json({ checked_at: new Date().toISOString(), repositories, write_permission: "unverified" });
  });
}

export type GitHubSettingsResponse = Awaited<ReturnType<typeof readSettings>>;

async function readSettings(context: Context) {
  let local: RunnerLocalSettings;
  try { local = await readLocalSettingsFile(path(context)); } catch (error) { throw settingsError(error); }
  const settings = savedSettings(context, local);
  const active = context.githubIssueSync?.configuration() ?? connector(context).issueSync;
  const snapshot = context.githubIssueSync?.snapshot();
  const repositories = new Map([...active.repositories, ...settings.repositories].map(policy => [policy.repository, policy]));
  return {
    revision: fingerprint(local), settings,
    credential: { mode: settings.auth.mode, reference: settings.auth.mode === "connector" ? connector(context).token_ref : settings.auth.mode === "github-app" ? settings.auth.privateKeyRef : "gh auth", value_exposed: false },
    application: { status: !context.githubIssueSync ? "unavailable" : fingerprint(settings) === fingerprint(active) ? "applied" : "pending",
      mode: "explicit_reload", active_enabled: active.enabled, active_settings: active },
    runtime: { available: Boolean(snapshot), enabled: snapshot?.enabled ?? false, running: snapshot?.running ?? false,
      last_run_at: snapshot?.last_run_at ?? "", last_error: publicGitHubSummary(String(snapshot?.last_error ?? "")) },
    permissions: { merge: false, deploy: false, note: "接管规则不替代 Action Gate、项目执行策略或人工审批；不授予自动合并和部署权限。" },
    projects: listProjects(context.database).map(p => ({ id: p.id, name: p.name, approval_policy: p.approval_policy, sandbox: p.sandbox })),
    repositories: [...repositories.values()].map(policy => {
      const cases = context.database.sqlite.query<GitHubIssueCase, [string]>("select * from github_issue_cases where repository=? order by updated_at desc, issue_number limit 100").all(policy.repository);
      const count = context.database.sqlite.query<{ total: number }, [string]>("select count(*) as total from github_issue_cases where repository=?").get(policy.repository)?.total ?? 0;
      return { repository: policy.repository, project_id: policy.projectId, intake_label: policy.intakeLabel, total: count, truncated: count > cases.length,
        cases: cases.map(record => {
          const work = record.issue_id ? getIssue(context.database, record.issue_id) : null;
          const source = safeObject(record.source_json);
          return { issue_number: record.issue_number, issue_id: record.issue_id, project_id: record.project_id, source_revision: record.source_revision,
            stage: record.stage, phase: work?.status === "needs_user" ? "needs_user" : record.stage, work_status: work?.status ?? "",
            intake_status: record.project_id !== policy.projectId ? "mapping_conflict" : !Array.isArray(source.labels) ? "unknown" : !source.labels.includes(policy.intakeLabel) ? "label_mismatch" : record.external_state === "closed" ? "closed" : "matched",
            external_state: record.external_state, pull_request_number: record.pull_request_number, last_error: publicGitHubSummary(record.last_error), updated_at: record.updated_at };
        }) };
    })
  };
}

function savedSettings(context: Context, local: RunnerLocalSettings): GitHubIssueSyncConfig {
  try { return buildGitHubIssueSyncConfig(local.integrations?.github?.issueSync ?? connector(context).issueSync); }
  catch { throw new HttpError(409, "config_invalid：已保存的 GitHub 接管配置无效，请修正本地设置后重试"); }
}

function submittedSettings(context: Context, value: unknown): GitHubIssueSyncConfig {
  const raw = object(value);
  only(raw, SETTINGS_FIELDS);
  booleanFields(raw, ["enabled"]);
  if (raw.auth !== undefined) {
    const auth = object(raw.auth);
    only(auth, ["mode", "appId", "installationId", "privateKeyRef"]);
    strings(auth, ["mode", "appId", "installationId", "privateKeyRef"]);
    if (auth.privateKeyRef && !/^(secret|env):\/\/[^\s]+$/.test(String(auth.privateKeyRef))) throw new HttpError(400, "只接受 privateKeyRef 凭据引用，不能提交私钥或 token");
  }
  if (!Array.isArray(raw.repositories)) throw new HttpError(400, "repositories 必须是数组");
  for (const value of raw.repositories) {
    const row = object(value);
    only(row, REPOSITORY_FIELDS);
    booleanFields(row, ["autoEnqueue", "allowFix", "allowPullRequest", "closeOnMerge"]);
    strings(row, ["repository", "projectId", "intakeLabel", "baseBranch", "ciFailureMode", "ciFailureReason"]);
    if (!String(row.intakeLabel ?? "").trim()) throw new HttpError(400, "请明确填写接管标签");
  }
  let next: GitHubIssueSyncConfig;
  try { next = buildGitHubIssueSyncConfig(raw); }
  catch { throw new HttpError(400, "GitHub 接管配置无效，请检查仓库、标签、凭据引用、轮询间隔及 CI 策略"); }
  if (!Number.isInteger(next.pollIntervalSeconds)) throw new HttpError(400, "轮询间隔必须是整数");
  for (const policy of next.repositories) if (!getProject(context.database, policy.projectId)) throw new HttpError(400, "mapped_project_missing：请选择已注册项目");
  return next;
}

function checkMappings(context: Context, next: GitHubIssueSyncConfig) {
  for (const policy of next.repositories) {
    if (!getProject(context.database, policy.projectId)) throw new HttpError(400, "mapped_project_missing：请选择已注册项目");
    const conflict = context.database.sqlite.query("select 1 from github_issue_cases where repository=? and project_id<>? limit 1").get(policy.repository, policy.projectId);
    if (conflict) throw new HttpError(409, "mapping_conflict：仓库已有属于其他项目的 Case，不能静默迁移");
  }
}

async function probeRepository(client: GitHubIssueClient, policy: GitHubIssueSyncConfig["repositories"][number]) {
  let readingLabel = false;
  try {
    const path = githubRepositoryPath(policy.repository);
    const { data } = await client.request(path);
    readingLabel = true;
    const label = await client.request(`${path}/labels/${encodeURIComponent(policy.intakeLabel)}`);
    const permission = safeObject(JSON.stringify(data.permissions ?? {}));
    const status = label.data.name !== policy.intakeLabel ? "label_mismatch"
      : (policy.allowFix || policy.allowPullRequest) && permission.push === false ? "permission_denied" : "connected";
    return { repository: policy.repository, status, write_permission: "unverified" };
  } catch (error) {
    const status = error instanceof GitHubIssueApiError
      ? error.status === 401 ? "authentication_failed" : error.retryable ? "temporarily_unavailable" : error.status === 403 ? "permission_denied"
        : error.status === 404 ? readingLabel ? "label_mismatch" : "repository_unavailable" : "connection_failed"
      : "credential_unavailable";
    return { repository: policy.repository, status, write_permission: "unverified" };
  }
}

function checkRevision(revision: unknown, current: RunnerLocalSettings) {
  if (typeof revision !== "string" || revision !== fingerprint(current)) throw new HttpError(409, "config_conflict：设置已被修改，请刷新并核对草稿后重试");
}
function audit(context: Context, action: string, settings: GitHubIssueSyncConfig) {
  createPiActionEvent(context.database, { actor: "user", action_id: `github-settings:${crypto.randomUUID()}`, event_type: `github.settings_${action}`,
    payload_json: JSON.stringify({ enabled: settings.enabled, repositories: settings.repositories.map(p => p.repository), settings_revision: fingerprint(settings) }), reason: `GitHub takeover settings ${action}` });
}
function settingsError(error: unknown) {
  if (error instanceof HttpError) return error;
  const code = (error as { code?: string })?.code;
  return code === "EACCES" || code === "EPERM" ? new HttpError(403, "settings_permission_denied：没有本地设置文件的读写权限")
    : new HttpError(500, "settings_io_failed：设置文件读写失败，请检查文件权限及 JSON；未确认生效");
}
function stateDir(context: Context) { return context.config?.stateDir || dirname(context.database.path); }
function path(context: Context) { return localSettingsPath(stateDir(context)); }
function connector(context: Context) { return context.config?.integrations.github ?? buildGitHubConnectorConfig(); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "设置必须是 JSON 对象");
  return value as Record<string, unknown>;
}
function safeObject(value: string) { try { return object(JSON.parse(value)); } catch { return {}; } }
function only(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, "包含不支持的接管设置字段；不得提交 token 或额外权限");
}
function booleanFields(value: Record<string, unknown>, names: string[]) {
  if (names.some(key => value[key] !== undefined && typeof value[key] !== "boolean")) throw new HttpError(400, "允许操作必须是布尔值");
}
function strings(value: Record<string, unknown>, names: string[]) {
  if (names.some(key => value[key] !== undefined && typeof value[key] !== "string")) throw new HttpError(400, "配置字段必须是字符串");
}
