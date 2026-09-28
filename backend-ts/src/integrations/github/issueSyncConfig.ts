export type GitHubIssueRepository = {
  repository: string;
  projectId: string;
  intakeLabel: string;
  autoEnqueue: boolean;
  allowFix: boolean;
  allowPullRequest: boolean;
  closeOnMerge: boolean;
  baseBranch: string;
  ciFailureMode: "repair" | "report_only";
  ciFailureReason: string;
};

export type GitHubIssueSyncConfig = {
  enabled: boolean;
  pollIntervalSeconds: number;
  auth: {
    mode: "connector" | "gh-cli" | "github-app";
    appId: string;
    installationId: string;
    privateKeyRef: string;
  };
  repositories: GitHubIssueRepository[];
};

export function buildGitHubIssueSyncConfig(value: unknown): GitHubIssueSyncConfig {
  const raw = object(value);
  const auth = object(raw.auth);
  const mode = choice(auth.mode, ["connector", "gh-cli", "github-app"] as const, "connector");
  const repositories = raw.repositories === undefined ? [] : raw.repositories;
  if (!Array.isArray(repositories) || repositories.length > 32) throw new Error("GitHub issueSync.repositories must contain at most 32 repositories");
  const normalized = repositories.map((item) => {
    const entry = object(item);
    const repository = text(entry.repository).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(repository) || [".", ".."].includes(repository.split("/")[1]!)) throw new Error("GitHub repository must be owner/repository");
    const projectId = text(entry.projectId);
    if (!projectId || projectId.length > 128) throw new Error("GitHub projectId is required");
    const intakeLabel = text(entry.intakeLabel) || "xuanwu";
    if (intakeLabel.length > 50 || /[\r\n\0]/.test(intakeLabel)) throw new Error("GitHub intakeLabel is invalid");
    const baseBranch = text(entry.baseBranch);
    if (baseBranch && (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(baseBranch) || baseBranch.includes("..") || baseBranch.includes("//"))) throw new Error("GitHub baseBranch is invalid");
    const ciFailureMode = choice(entry.ciFailureMode, ["repair", "report_only"] as const, "repair");
    const ciFailureReason = text(entry.ciFailureReason);
    if (ciFailureReason.length > 500 || (ciFailureMode === "report_only" && !ciFailureReason)) throw new Error("GitHub report_only CI policy requires a reason up to 500 characters");
    return { repository, projectId, intakeLabel, baseBranch, ciFailureMode, ciFailureReason,
      autoEnqueue: entry.autoEnqueue === true, allowFix: entry.allowFix === true,
      allowPullRequest: entry.allowPullRequest === true, closeOnMerge: entry.closeOnMerge === true };
  });
  if (new Set(normalized.map(item => item.repository)).size !== normalized.length) throw new Error("GitHub repositories must be unique");
  if (raw.enabled === true && normalized.length === 0) throw new Error("Enabled GitHub issue sync requires a repository");
  if (mode === "github-app" && (!text(auth.appId) || !/^\d+$/.test(text(auth.installationId)) || !secretRef(auth.privateKeyRef))) {
    throw new Error("GitHub App requires appId, installationId and privateKeyRef");
  }
  return {
    enabled: raw.enabled === true,
    pollIntervalSeconds: bounded(raw.pollIntervalSeconds, 60, 15, 3600),
    auth: { mode, appId: text(auth.appId), installationId: text(auth.installationId), privateKeyRef: text(auth.privateKeyRef) },
    repositories: normalized
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub issue sync configuration must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function secretRef(value: unknown): boolean { return /^(secret|env):\/\/[^\s]+$/.test(text(value)); }
function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new Error(`Expected one of ${values.join(", ")}`);
  return value as T;
}
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Expected a number between ${min} and ${max}`);
  return value;
}
