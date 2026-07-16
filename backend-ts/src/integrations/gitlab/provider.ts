import {
  REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
  RemoteGitIdempotencyConflictError,
  RemoteGitProviderError,
  assertRemoteGitWriteContext,
  type RemoteGitCreatePullRequestRequest,
  type RemoteGitMutationResponse,
  type RemoteGitProvider,
  type RemoteGitProviderResponse,
  type RemoteGitPullRequest,
  type RemoteGitPushBranchRequest,
  type RemoteGitPushResult,
  type RemoteGitReadPullRequestRequest,
  type RemoteGitUpdatePullRequestRequest
} from "../git/remoteProvider.ts";
import {
  RemoteGitMutationCoordinator,
  arrayValue,
  assertGitBranch,
  assertGitRevision,
  assertRepositoryRef,
  basicAuthorization,
  bodyWithIdempotencyMarker,
  bodyWithoutIdempotencyMarker,
  canonicalFingerprint,
  cleanInteger,
  cleanText,
  createRemoteGitCli,
  createRemoteGitHttpClient,
  executeAuditedRemoteGitMutation,
  idempotencyMarker,
  markerFingerprint,
  normalizeProviderError,
  normalizedStringList,
  numberHeader,
  objectValue,
  preserveIdempotencyMarkers,
  remoteUrl,
  requiredProviderText,
  requiredRedactedProviderMultilineText,
  requiredRedactedProviderText,
  resetAtFromEpoch,
  resolveRemoteGitToken,
  retryAfterSeconds,
  type FetchLike,
  type RemoteGitAdapterAuditSink,
  type RemoteGitCli,
  type RemoteGitHttpClient,
  type RemoteGitHttpResult,
  type RemoteGitMutationReceiptStore
} from "../git/adapterSupport.ts";
import type { RemoteGitRateLimit } from "../git/remoteProvider.ts";
import type { GitLabConnectorConfig } from "./config.ts";

export type GitLabRemoteGitProviderOptions = {
  audit_sink: RemoteGitAdapterAuditSink;
  config: GitLabConnectorConfig;
  fetch?: FetchLike;
  git_cli?: RemoteGitCli;
  receipts: RemoteGitMutationReceiptStore;
};

export function createGitLabRemoteGitProvider(options: GitLabRemoteGitProviderOptions): RemoteGitProvider {
  return new GitLabRemoteGitProvider(options);
}

class GitLabRemoteGitProvider implements RemoteGitProvider {
  readonly descriptor = {
    contract_version: REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
    display_name: "GitLab",
    provider_id: "gitlab"
  } as const;

  private readonly api: RemoteGitHttpClient;
  private readonly coordinator: RemoteGitMutationCoordinator;
  private readonly git: RemoteGitCli;

  constructor(private readonly options: GitLabRemoteGitProviderOptions) {
    this.api = createRemoteGitHttpClient({
      auth_header: (token) => ({ "private-token": token }),
      config: options.config,
      fetch: options.fetch,
      rate_limit: gitlabRateLimit,
      request_ref: (headers) => cleanText(headers.get("x-request-id")) || undefined
    });
    this.coordinator = new RemoteGitMutationCoordinator(options.receipts);
    this.git = options.git_cli ?? createRemoteGitCli();
  }

  async pushBranch(request: RemoteGitPushBranchRequest): Promise<RemoteGitMutationResponse<RemoteGitPushResult>> {
    const operation = "push_branch" as const;
    assertRemoteGitWriteContext(request.write, operation);
    const repositoryRef = assertRepositoryRef(request.repository, this.descriptor.provider_id, operation);
    const token = resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const remoteBranch = assertGitBranch(request.remote_branch, "remote_branch", operation, this.descriptor.provider_id);
    const localBranch = assertGitBranch(request.local_branch_ref, "local_branch_ref", operation, this.descriptor.provider_id);
    const commitRef = assertGitRevision(request.commit_ref, "commit_ref", operation, this.descriptor.provider_id);
    const expectedRemoteRevision = request.expected_remote_revision === null ? null
      : assertGitRevision(request.expected_remote_revision, "expected_remote_revision", operation, this.descriptor.provider_id);
    const localRepositoryPath = requiredProviderText(
      request.local_repository_path, "local_repository_path", operation, this.descriptor.provider_id, 4096
    );
    const fingerprint = canonicalFingerprint({
      commit_ref: commitRef,
      expected_remote_revision: expectedRemoteRevision,
      local_branch_ref: localBranch,
      local_repository_path: localRepositoryPath,
      remote_branch: remoteBranch,
      repository_ref: repositoryRef
    });

    return executeAuditedRemoteGitMutation({
      audit_sink: this.options.audit_sink,
      coordinator: this.coordinator,
      fingerprint,
      operation,
      provider_id: this.descriptor.provider_id,
      repository_ref: repositoryRef,
      target_ref: `refs/heads/${remoteBranch}`,
      write: request.write,
      perform: async () => {
        try {
          const pushed = await this.git.push({
            authorization_header: basicAuthorization("oauth2", token),
            commit_ref: commitRef,
            expected_remote_revision: expectedRemoteRevision,
            local_branch_ref: localBranch,
            local_repository_path: localRepositoryPath,
            remote_branch: remoteBranch,
            remote_url: remoteUrl(this.options.config, repositoryRef)
          });
          const before = pushed.before_revision;
          return {
            idempotency: { key: request.write.idempotency_key, replayed: pushed.recovered },
            value: {
              before_revision: before,
              commit_ref: commitRef,
              outcome: before === commitRef ? "unchanged" : before === null ? "created" : "updated",
              remote_branch: remoteBranch,
              remote_ref: `gitlab:${repositoryRef}:refs/heads/${remoteBranch}`
            }
          };
        } catch (error) {
          throw gitProviderError(error, operation);
        }
      }
    });
  }

  async createPullRequest(request: RemoteGitCreatePullRequestRequest): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>> {
    const operation = "create_pull_request" as const;
    assertRemoteGitWriteContext(request.write, operation);
    const repositoryRef = assertRepositoryRef(request.repository, this.descriptor.provider_id, operation);
    resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const normalized = normalizeCreateRequest(request, repositoryRef);
    const fingerprint = canonicalFingerprint(normalized);
    const marker = idempotencyMarker({
      fingerprint,
      idempotency_key: request.write.idempotency_key,
      operation,
      provider_id: this.descriptor.provider_id,
      repository_ref: repositoryRef
    });

    return executeAuditedRemoteGitMutation({
      audit_sink: this.options.audit_sink,
      coordinator: this.coordinator,
      fingerprint,
      operation,
      provider_id: this.descriptor.provider_id,
      repository_ref: repositoryRef,
      target_ref: `${normalized.head_branch}->${normalized.base_branch}`,
      write: request.write,
      perform: async () => {
        const recovered = await this.findCreateByMarker(repositoryRef, normalized, marker);
        let raw = recovered.raw;
        let mutationResult = recovered.http;
        if (!raw) {
          mutationResult = await this.api.request({
            body: {
              description: bodyWithIdempotencyMarker(normalized.body, marker.text),
              labels: normalized.labels.join(","),
              reviewer_ids: normalized.reviewer_refs.map(Number),
              source_branch: normalized.head_branch,
              target_branch: normalized.base_branch,
              title: gitlabTitle(normalized.title, normalized.readiness)
            },
            method: "POST",
            operation,
            path: `${projectPath(repositoryRef)}/merge_requests`
          });
          raw = objectValue(mutationResult.value);
        } else {
          const iid = gitlabMergeRequestIID(raw, operation);
          await this.api.request({
            body: { labels: normalized.labels.join(","), reviewer_ids: normalized.reviewer_refs.map(Number) },
            method: "PUT",
            operation,
            path: `${projectPath(repositoryRef)}/merge_requests/${iid}`
          });
        }
        const iid = gitlabMergeRequestIID(raw, operation);
        const read = await this.readRaw(repositoryRef, iid, operation);
        const value = normalizeGitLabMergeRequest(read.raw, repositoryRef);
        assertCreatedMergeRequest(value, normalized, operation);
        return mutationResponse(
          value,
          request.write.idempotency_key,
          recovered.replayed,
          read.http ?? mutationResult
        );
      }
    });
  }

  async updatePullRequest(request: RemoteGitUpdatePullRequestRequest): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>> {
    const operation = "update_pull_request" as const;
    assertRemoteGitWriteContext(request.write, operation);
    const repositoryRef = assertRepositoryRef(request.repository, this.descriptor.provider_id, operation);
    resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const iid = parseGitLabMergeRequestRef(request.pull_request_ref, repositoryRef, operation);
    const patch = normalizePatch(request.patch, operation);
    const fingerprint = canonicalFingerprint({ patch, pull_request_ref: request.pull_request_ref, repository_ref: repositoryRef });

    return executeAuditedRemoteGitMutation({
      audit_sink: this.options.audit_sink,
      coordinator: this.coordinator,
      fingerprint,
      operation,
      provider_id: this.descriptor.provider_id,
      repository_ref: repositoryRef,
      target_ref: request.pull_request_ref,
      write: request.write,
      perform: async () => {
        const current = await this.readRaw(repositoryRef, iid, operation);
        const currentValue = normalizeGitLabMergeRequest(current.raw, repositoryRef);
        if (patchSatisfied(currentValue, patch)) {
          return mutationResponse(currentValue, request.write.idempotency_key, true, current.http);
        }
        const body: Record<string, unknown> = {};
        if (patch.body !== undefined) body.description = preserveIdempotencyMarkers(patch.body, current.raw.description);
        if (patch.labels !== undefined) body.labels = patch.labels.join(",");
        if (patch.reviewer_refs !== undefined) body.reviewer_ids = patch.reviewer_refs.map(Number);
        const targetReadiness = patch.readiness ?? currentValue.readiness;
        if (patch.title !== undefined || patch.readiness !== undefined) {
          body.title = gitlabTitle(patch.title ?? currentValue.title, targetReadiness);
        }
        await this.api.request({
          body,
          method: "PUT",
          operation,
          path: `${projectPath(repositoryRef)}/merge_requests/${iid}`
        });
        const read = await this.readRaw(repositoryRef, iid, operation);
        return mutationResponse(normalizeGitLabMergeRequest(read.raw, repositoryRef), request.write.idempotency_key, false, read.http);
      }
    });
  }

  async readPullRequest(request: RemoteGitReadPullRequestRequest): Promise<RemoteGitProviderResponse<RemoteGitPullRequest>> {
    const operation = "read_pull_request" as const;
    const repositoryRef = assertRepositoryRef(request.repository, this.descriptor.provider_id, operation);
    resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const iid = parseGitLabMergeRequestRef(request.pull_request_ref, repositoryRef, operation);
    const read = await this.readRaw(repositoryRef, iid, operation);
    return {
      provider_request_ref: read.http.provider_request_ref,
      rate_limit: read.http.rate_limit,
      value: normalizeGitLabMergeRequest(read.raw, repositoryRef)
    };
  }

  private async findCreateByMarker(
    repositoryRef: string,
    request: ReturnType<typeof normalizeCreateRequest>,
    marker: ReturnType<typeof idempotencyMarker>
  ): Promise<{ http?: RemoteGitHttpResult; raw: Record<string, unknown> | null; replayed: boolean }> {
    const query = new URLSearchParams({
      per_page: "100",
      scope: "all",
      source_branch: request.head_branch,
      state: "all",
      target_branch: request.base_branch
    });
    const http = await this.api.request({
      operation: "create_pull_request",
      path: `${projectPath(repositoryRef)}/merge_requests?${query}`
    });
    for (const item of arrayValue(http.value).map(objectValue)) {
      const fingerprint = markerFingerprint(item.description, marker.key_hash);
      if (fingerprint === null) continue;
      if (fingerprint !== marker.fingerprint_hash) {
        throw new RemoteGitIdempotencyConflictError("GitLab MR marker is bound to another mutation", {
          idempotency_key: request.idempotency_key,
          operation: "create_pull_request",
          provider_id: this.descriptor.provider_id,
          provider_request_ref: http.provider_request_ref
        });
      }
      return { http, raw: item, replayed: true };
    }
    return { http, raw: null, replayed: false };
  }

  private async readRaw(
    repositoryRef: string,
    iid: number,
    operation: "create_pull_request" | "update_pull_request" | "read_pull_request"
  ): Promise<{ http: RemoteGitHttpResult; raw: Record<string, unknown> }> {
    const http = await this.api.request({ operation, path: `${projectPath(repositoryRef)}/merge_requests/${iid}` });
    return { http, raw: objectValue(http.value) };
  }
}

function gitlabRateLimit(headers: Headers): RemoteGitRateLimit | undefined {
  const rateLimit = {
    limit: numberHeader(headers, "ratelimit-limit"),
    remaining: numberHeader(headers, "ratelimit-remaining"),
    reset_at: resetAtFromEpoch(numberHeader(headers, "ratelimit-reset")),
    resource: "api",
    retry_after_seconds: retryAfterSeconds(headers)
  };
  return Object.values(rateLimit).some((value) => value !== undefined) ? rateLimit : undefined;
}

function projectPath(repositoryRef: string): string {
  return `/projects/${encodeURIComponent(repositoryRef)}`;
}

function normalizeCreateRequest(request: RemoteGitCreatePullRequestRequest, repositoryRef: string) {
  const operation = "create_pull_request" as const;
  if (request.readiness !== "draft" && request.readiness !== "ready") {
    throw new RemoteGitProviderError("readiness is invalid", { kind: "validation", operation, provider_id: "gitlab" });
  }
  return {
    base_branch: assertGitBranch(request.base_branch, "base_branch", operation, "gitlab"),
    body: requiredRedactedProviderMultilineText(request.body, "body", operation, "gitlab"),
    head_branch: assertGitBranch(request.head_branch, "head_branch", operation, "gitlab"),
    head_revision: assertGitRevision(request.head_revision, "head_revision", operation, "gitlab"),
    idempotency_key: request.write.idempotency_key,
    labels: normalizedStringList(request.labels, "labels", operation, "gitlab"),
    readiness: request.readiness,
    repository_ref: repositoryRef,
    reviewer_refs: gitlabReviewerRefs(request.reviewer_refs, operation),
    title: requiredRedactedProviderText(request.title, "title", operation, "gitlab", 1024)
  };
}

function normalizePatch(patch: RemoteGitUpdatePullRequestRequest["patch"], operation: "update_pull_request") {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new RemoteGitProviderError("patch must be an object", { kind: "validation", operation, provider_id: "gitlab" });
  }
  const normalized: {
    body?: string;
    labels?: string[];
    readiness?: "draft" | "ready";
    reviewer_refs?: string[];
    title?: string;
  } = {};
  if (patch.body !== undefined) normalized.body = requiredRedactedProviderMultilineText(patch.body, "patch.body", operation, "gitlab");
  if (patch.labels !== undefined) normalized.labels = normalizedStringList(patch.labels, "patch.labels", operation, "gitlab");
  if (patch.readiness !== undefined) {
    if (patch.readiness !== "draft" && patch.readiness !== "ready") {
      throw new RemoteGitProviderError("patch.readiness is invalid", { kind: "validation", operation, provider_id: "gitlab" });
    }
    normalized.readiness = patch.readiness;
  }
  if (patch.reviewer_refs !== undefined) normalized.reviewer_refs = gitlabReviewerRefs(patch.reviewer_refs, operation);
  if (patch.title !== undefined) normalized.title = requiredRedactedProviderText(patch.title, "patch.title", operation, "gitlab", 1024);
  if (Object.keys(normalized).length === 0) {
    throw new RemoteGitProviderError("patch must contain at least one field", { kind: "validation", operation, provider_id: "gitlab" });
  }
  return normalized;
}

function gitlabReviewerRefs(
  value: readonly string[] | undefined,
  operation: "create_pull_request" | "update_pull_request"
): string[] {
  const refs = normalizedStringList(value, "reviewer_refs", operation, "gitlab");
  if (refs.some((ref) => !/^[1-9]\d*$/.test(ref))) {
    throw new RemoteGitProviderError("GitLab reviewer_refs must be numeric user IDs", {
      kind: "validation", operation, provider_id: "gitlab"
    });
  }
  return refs;
}

function normalizeGitLabMergeRequest(raw: Record<string, unknown>, repositoryRef: string): RemoteGitPullRequest {
  const iid = gitlabMergeRequestIID(raw, "read_pull_request");
  const state = cleanText(raw.state);
  const draft = raw.draft === true || /^(?:Draft:|\[Draft\]|\(Draft\))\s*/i.test(cleanText(raw.title));
  return {
    base_branch: cleanText(raw.target_branch),
    body: bodyWithoutIdempotencyMarker(raw.description),
    head_branch: cleanText(raw.source_branch),
    head_revision: cleanText(raw.sha),
    labels: arrayValue(raw.labels).map((item) => cleanText(typeof item === "string" ? item : objectValue(item).name)).filter(Boolean),
    lifecycle: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    pull_request_ref: `gitlab:${repositoryRef}!${iid}`,
    readiness: draft ? "draft" : "ready",
    repository_ref: repositoryRef,
    reviewer_refs: arrayValue(raw.reviewers).map((item) => cleanInteger(objectValue(item).id)?.toString() ?? "").filter(Boolean),
    title: cleanText(raw.title).replace(/^(?:Draft:|\[Draft\]|\(Draft\))\s*/i, ""),
    updated_at: cleanText(raw.updated_at),
    url: cleanText(raw.web_url)
  };
}

function assertCreatedMergeRequest(
  value: RemoteGitPullRequest,
  request: ReturnType<typeof normalizeCreateRequest>,
  operation: "create_pull_request"
): void {
  if (value.base_branch !== request.base_branch || value.head_branch !== request.head_branch ||
    value.head_revision !== request.head_revision) {
    throw new RemoteGitProviderError("GitLab merge request does not reference the requested head revision", {
      kind: "conflict", operation, provider_id: "gitlab"
    });
  }
}

function gitlabMergeRequestIID(raw: Record<string, unknown>, operation: "create_pull_request" | "read_pull_request"): number {
  const iid = cleanInteger(raw.iid);
  if (iid === undefined || iid === 0) {
    throw new RemoteGitProviderError("GitLab response is missing merge request iid", {
      kind: "temporary", operation, provider_id: "gitlab"
    });
  }
  return iid;
}

function parseGitLabMergeRequestRef(value: string, repositoryRef: string, operation: "update_pull_request" | "read_pull_request"): number {
  const match = value.match(/^gitlab:(.+)!([1-9]\d*)$/);
  if (!match || match[1] !== repositoryRef) {
    throw new RemoteGitProviderError("GitLab pull_request_ref is invalid for repository", {
      kind: "validation", operation, provider_id: "gitlab"
    });
  }
  return Number(match[2]);
}

function gitlabTitle(title: string, readiness: "draft" | "ready"): string {
  const plain = title.replace(/^(?:Draft:|\[Draft\]|\(Draft\))\s*/i, "");
  return readiness === "draft" ? `Draft: ${plain}` : plain;
}

function patchSatisfied(current: RemoteGitPullRequest, patch: ReturnType<typeof normalizePatch>): boolean {
  return (patch.body === undefined || current.body === patch.body) &&
    (patch.title === undefined || current.title === patch.title) &&
    (patch.readiness === undefined || current.readiness === patch.readiness) &&
    (patch.labels === undefined || equalSet(current.labels, patch.labels)) &&
    (patch.reviewer_refs === undefined || equalSet(current.reviewer_refs, patch.reviewer_refs));
}

function equalSet(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((item, index) => item === sortedRight[index]);
}

function mutationResponse<T>(value: T, key: string, replayed: boolean, http?: RemoteGitHttpResult): RemoteGitMutationResponse<T> {
  return {
    idempotency: { key, replayed },
    provider_request_ref: http?.provider_request_ref,
    rate_limit: http?.rate_limit,
    value
  };
}

function gitProviderError(error: unknown, operation: "push_branch"): RemoteGitProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (/remote branch changed after preflight|stale info|\[rejected\]|fetch first/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "conflict", operation, provider_id: "gitlab" });
  }
  if (message.includes("local branch does not resolve")) {
    return new RemoteGitProviderError(message, { kind: "validation", operation, provider_id: "gitlab" });
  }
  if (/repository not found/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "not_found", operation, provider_id: "gitlab" });
  }
  if (/authentication failed|could not read username|invalid credentials/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "auth", operation, provider_id: "gitlab" });
  }
  if (/permission denied|\b403\b/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "permission", operation, provider_id: "gitlab" });
  }
  return normalizeProviderError(error, operation, "gitlab");
}
