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
import type { GitHubConnectorConfig } from "./config.ts";

export type GitHubRemoteGitProviderOptions = {
  audit_sink: RemoteGitAdapterAuditSink;
  config: GitHubConnectorConfig;
  fetch?: FetchLike;
  git_cli?: RemoteGitCli;
  receipts: RemoteGitMutationReceiptStore;
};

export function createGitHubRemoteGitProvider(options: GitHubRemoteGitProviderOptions): RemoteGitProvider {
  return new GitHubRemoteGitProvider(options);
}

class GitHubRemoteGitProvider implements RemoteGitProvider {
  readonly descriptor = {
    contract_version: REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
    display_name: "GitHub",
    provider_id: "github"
  } as const;

  private readonly api: RemoteGitHttpClient;
  private readonly graphql: RemoteGitHttpClient;
  private readonly coordinator: RemoteGitMutationCoordinator;
  private readonly git: RemoteGitCli;

  constructor(private readonly options: GitHubRemoteGitProviderOptions) {
    this.api = githubHttpClient(options.config, options.fetch);
    this.graphql = githubHttpClient({ ...options.config, api_base_url: options.config.graphql_base_url }, options.fetch);
    this.coordinator = new RemoteGitMutationCoordinator(options.receipts);
    this.git = options.git_cli ?? createRemoteGitCli();
  }

  async pushBranch(request: RemoteGitPushBranchRequest): Promise<RemoteGitMutationResponse<RemoteGitPushResult>> {
    const operation = "push_branch" as const;
    assertRemoteGitWriteContext(request.write, operation);
    const repositoryRef = githubRepository(request.repository, operation);
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
            authorization_header: basicAuthorization("x-access-token", token),
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
              remote_ref: `github:${repositoryRef}:refs/heads/${remoteBranch}`
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
    const repositoryRef = githubRepository(request.repository, operation);
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
              base: normalized.base_branch,
              body: bodyWithIdempotencyMarker(normalized.body, marker.text),
              draft: normalized.readiness === "draft",
              head: normalized.head_branch,
              title: normalized.title
            },
            method: "POST",
            operation,
            path: `${repoPath(repositoryRef)}/pulls`
          });
          raw = objectValue(mutationResult.value);
        }
        const number = githubPullNumber(raw, operation);
        await this.setLabels(repositoryRef, number, normalized.labels, operation);
        await this.setReviewers(repositoryRef, number, normalized.reviewer_refs, operation);
        const read = await this.readRaw(repositoryRef, number, operation);
        const value = normalizeGitHubPullRequest(read.raw, repositoryRef);
        assertCreatedPullRequest(value, normalized, operation);
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
    const repositoryRef = githubRepository(request.repository, operation);
    resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const number = parseGitHubPullRequestRef(request.pull_request_ref, repositoryRef, operation);
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
        let current = await this.readRaw(repositoryRef, number, operation);
        if (patchSatisfied(normalizeGitHubPullRequest(current.raw, repositoryRef), patch)) {
          return mutationResponse(normalizeGitHubPullRequest(current.raw, repositoryRef), request.write.idempotency_key, true, current.http);
        }
        const pullPatch: Record<string, unknown> = {};
        if (patch.title !== undefined) pullPatch.title = patch.title;
        if (patch.body !== undefined) pullPatch.body = preserveIdempotencyMarkers(patch.body, current.raw.body);
        if (Object.keys(pullPatch).length > 0) {
          await this.api.request({ body: pullPatch, method: "PATCH", operation, path: `${repoPath(repositoryRef)}/pulls/${number}` });
        }
        if (patch.readiness !== undefined) {
          const raw = current.raw;
          const currentReadiness = raw.draft === true ? "draft" : "ready";
          if (currentReadiness !== patch.readiness) await this.updateReadiness(raw, patch.readiness, operation);
        }
        if (patch.labels !== undefined) await this.setLabels(repositoryRef, number, patch.labels, operation);
        if (patch.reviewer_refs !== undefined) await this.setReviewers(repositoryRef, number, patch.reviewer_refs, operation);
        current = await this.readRaw(repositoryRef, number, operation);
        return mutationResponse(normalizeGitHubPullRequest(current.raw, repositoryRef), request.write.idempotency_key, false, current.http);
      }
    });
  }

  async readPullRequest(request: RemoteGitReadPullRequestRequest): Promise<RemoteGitProviderResponse<RemoteGitPullRequest>> {
    const operation = "read_pull_request" as const;
    const repositoryRef = githubRepository(request.repository, operation);
    resolveRemoteGitToken(this.options.config, request.auth_ref, operation);
    const number = parseGitHubPullRequestRef(request.pull_request_ref, repositoryRef, operation);
    const read = await this.readRaw(repositoryRef, number, operation);
    return {
      provider_request_ref: read.http.provider_request_ref,
      rate_limit: read.http.rate_limit,
      value: normalizeGitHubPullRequest(read.raw, repositoryRef)
    };
  }

  private async findCreateByMarker(
    repositoryRef: string,
    request: ReturnType<typeof normalizeCreateRequest>,
    marker: ReturnType<typeof idempotencyMarker>
  ): Promise<{ http?: RemoteGitHttpResult; raw: Record<string, unknown> | null; replayed: boolean }> {
    const owner = repositoryRef.split("/")[0];
    const query = new URLSearchParams({
      base: request.base_branch,
      head: `${owner}:${request.head_branch}`,
      per_page: "100",
      state: "all"
    });
    const http = await this.api.request({
      operation: "create_pull_request",
      path: `${repoPath(repositoryRef)}/pulls?${query}`
    });
    for (const item of arrayValue(http.value).map(objectValue)) {
      const fingerprint = markerFingerprint(item.body, marker.key_hash);
      if (fingerprint === null) continue;
      if (fingerprint !== marker.fingerprint_hash) {
        throw new RemoteGitIdempotencyConflictError("GitHub PR marker is bound to another mutation", {
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

  private async setLabels(repositoryRef: string, number: number, labels: string[], operation: "create_pull_request" | "update_pull_request"): Promise<void> {
    await this.api.request({
      body: { labels },
      method: "PUT",
      operation,
      path: `${repoPath(repositoryRef)}/issues/${number}/labels`
    });
  }

  private async setReviewers(
    repositoryRef: string,
    number: number,
    reviewers: string[],
    operation: "create_pull_request" | "update_pull_request"
  ): Promise<void> {
    const current = await this.readRaw(repositoryRef, number, operation);
    const currentReviewers = arrayValue(current.raw.requested_reviewers).map((item) => cleanText(objectValue(item).login)).filter(Boolean);
    const remove = currentReviewers.filter((reviewer) => !reviewers.includes(reviewer));
    const add = reviewers.filter((reviewer) => !currentReviewers.includes(reviewer));
    if (remove.length > 0) {
      await this.api.request({
        body: { reviewers: remove },
        method: "DELETE",
        operation,
        path: `${repoPath(repositoryRef)}/pulls/${number}/requested_reviewers`
      });
    }
    if (add.length > 0) {
      await this.api.request({
        body: { reviewers: add },
        method: "POST",
        operation,
        path: `${repoPath(repositoryRef)}/pulls/${number}/requested_reviewers`
      });
    }
  }

  private async updateReadiness(
    raw: Record<string, unknown>,
    readiness: "draft" | "ready",
    operation: "update_pull_request"
  ): Promise<void> {
    const pullRequestID = requiredProviderText(raw.node_id, "GitHub pull request node_id", operation, this.descriptor.provider_id);
    const field = readiness === "ready" ? "markPullRequestReadyForReview" : "convertPullRequestToDraft";
    const result = await this.graphql.request({
      body: {
        query: `mutation($pullRequestId: ID!) { ${field}(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }`,
        variables: { pullRequestId: pullRequestID }
      },
      method: "POST",
      operation,
      path: ""
    });
    const errors = arrayValue(objectValue(result.value).errors);
    if (errors.length > 0) {
      throw new RemoteGitProviderError(`GitHub readiness mutation failed: ${cleanText(objectValue(errors[0]).message)}`, {
        kind: "validation",
        operation,
        provider_id: this.descriptor.provider_id,
        provider_request_ref: result.provider_request_ref,
        rate_limit: result.rate_limit,
        status_code: result.status
      });
    }
  }

  private async readRaw(
    repositoryRef: string,
    number: number,
    operation: "create_pull_request" | "update_pull_request" | "read_pull_request"
  ): Promise<{ http: RemoteGitHttpResult; raw: Record<string, unknown> }> {
    const http = await this.api.request({ operation, path: `${repoPath(repositoryRef)}/pulls/${number}` });
    return { http, raw: objectValue(http.value) };
  }
}

function githubHttpClient(config: GitHubConnectorConfig, fetchImpl?: FetchLike): RemoteGitHttpClient {
  return createRemoteGitHttpClient({
    auth_header: (token) => ({ authorization: `Bearer ${token}`, "x-github-api-version": "2026-03-10" }),
    config,
    fetch: fetchImpl,
    rate_limit: githubRateLimit,
    request_ref: (headers) => cleanText(headers.get("x-github-request-id")) || undefined
  });
}

function githubRateLimit(headers: Headers): RemoteGitRateLimit | undefined {
  const rateLimit = {
    limit: numberHeader(headers, "x-ratelimit-limit"),
    remaining: numberHeader(headers, "x-ratelimit-remaining"),
    reset_at: resetAtFromEpoch(numberHeader(headers, "x-ratelimit-reset")),
    resource: cleanText(headers.get("x-ratelimit-resource")) || undefined,
    retry_after_seconds: retryAfterSeconds(headers)
  };
  return Object.values(rateLimit).some((value) => value !== undefined) ? rateLimit : undefined;
}

function githubRepository(repository: RemoteGitCreatePullRequestRequest["repository"], operation: Parameters<typeof assertRepositoryRef>[2]): string {
  const ref = assertRepositoryRef(repository, "github", operation);
  if (ref.split("/").length !== 2) {
    throw new RemoteGitProviderError("GitHub repository_ref must be owner/repository", {
      kind: "validation", operation, provider_id: "github"
    });
  }
  return ref;
}

function repoPath(repositoryRef: string): string {
  return `/repos/${repositoryRef.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeCreateRequest(request: RemoteGitCreatePullRequestRequest, repositoryRef: string) {
  const operation = "create_pull_request" as const;
  if (request.readiness !== "draft" && request.readiness !== "ready") {
    throw new RemoteGitProviderError("readiness is invalid", { kind: "validation", operation, provider_id: "github" });
  }
  return {
    base_branch: assertGitBranch(request.base_branch, "base_branch", operation, "github"),
    body: requiredRedactedProviderMultilineText(request.body, "body", operation, "github"),
    head_branch: assertGitBranch(request.head_branch, "head_branch", operation, "github"),
    head_revision: assertGitRevision(request.head_revision, "head_revision", operation, "github"),
    idempotency_key: request.write.idempotency_key,
    labels: normalizedStringList(request.labels, "labels", operation, "github"),
    readiness: request.readiness,
    repository_ref: repositoryRef,
    reviewer_refs: normalizedStringList(request.reviewer_refs, "reviewer_refs", operation, "github"),
    title: requiredRedactedProviderText(request.title, "title", operation, "github", 1024)
  };
}

function normalizePatch(patch: RemoteGitUpdatePullRequestRequest["patch"], operation: "update_pull_request") {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new RemoteGitProviderError("patch must be an object", { kind: "validation", operation, provider_id: "github" });
  }
  const normalized: {
    body?: string;
    labels?: string[];
    readiness?: "draft" | "ready";
    reviewer_refs?: string[];
    title?: string;
  } = {};
  if (patch.body !== undefined) normalized.body = requiredRedactedProviderMultilineText(patch.body, "patch.body", operation, "github");
  if (patch.labels !== undefined) normalized.labels = normalizedStringList(patch.labels, "patch.labels", operation, "github");
  if (patch.readiness !== undefined) {
    if (patch.readiness !== "draft" && patch.readiness !== "ready") {
      throw new RemoteGitProviderError("patch.readiness is invalid", { kind: "validation", operation, provider_id: "github" });
    }
    normalized.readiness = patch.readiness;
  }
  if (patch.reviewer_refs !== undefined) {
    normalized.reviewer_refs = normalizedStringList(patch.reviewer_refs, "patch.reviewer_refs", operation, "github");
  }
  if (patch.title !== undefined) normalized.title = requiredRedactedProviderText(patch.title, "patch.title", operation, "github", 1024);
  if (Object.keys(normalized).length === 0) {
    throw new RemoteGitProviderError("patch must contain at least one field", { kind: "validation", operation, provider_id: "github" });
  }
  return normalized;
}

function normalizeGitHubPullRequest(raw: Record<string, unknown>, repositoryRef: string): RemoteGitPullRequest {
  const number = githubPullNumber(raw, "read_pull_request");
  const state = cleanText(raw.state);
  return {
    base_branch: cleanText(objectValue(raw.base).ref),
    body: bodyWithoutIdempotencyMarker(raw.body),
    head_branch: cleanText(objectValue(raw.head).ref),
    head_revision: cleanText(objectValue(raw.head).sha),
    labels: arrayValue(raw.labels).map((item) => cleanText(objectValue(item).name)).filter(Boolean),
    lifecycle: raw.merged_at ? "merged" : state === "closed" ? "closed" : "open",
    pull_request_ref: `github:${repositoryRef}#${number}`,
    readiness: raw.draft === true ? "draft" : "ready",
    repository_ref: repositoryRef,
    reviewer_refs: arrayValue(raw.requested_reviewers).map((item) => cleanText(objectValue(item).login)).filter(Boolean),
    title: cleanText(raw.title),
    updated_at: cleanText(raw.updated_at),
    url: cleanText(raw.html_url)
  };
}

function assertCreatedPullRequest(
  value: RemoteGitPullRequest,
  request: ReturnType<typeof normalizeCreateRequest>,
  operation: "create_pull_request"
): void {
  if (value.base_branch !== request.base_branch || value.head_branch !== request.head_branch ||
    value.head_revision !== request.head_revision) {
    throw new RemoteGitProviderError("GitHub pull request does not reference the requested head revision", {
      kind: "conflict", operation, provider_id: "github"
    });
  }
}

function githubPullNumber(raw: Record<string, unknown>, operation: "create_pull_request" | "read_pull_request"): number {
  const number = cleanInteger(raw.number);
  if (number === undefined || number === 0) {
    throw new RemoteGitProviderError("GitHub response is missing pull request number", {
      kind: "temporary", operation, provider_id: "github"
    });
  }
  return number;
}

function parseGitHubPullRequestRef(value: string, repositoryRef: string, operation: "update_pull_request" | "read_pull_request"): number {
  const match = value.match(/^github:(.+)#([1-9]\d*)$/);
  if (!match || match[1] !== repositoryRef) {
    throw new RemoteGitProviderError("GitHub pull_request_ref is invalid for repository", {
      kind: "validation", operation, provider_id: "github"
    });
  }
  return Number(match[2]);
}

function patchSatisfied(current: RemoteGitPullRequest, patch: ReturnType<typeof normalizePatch>): boolean {
  return (patch.body === undefined || current.body === patch.body) &&
    (patch.title === undefined || current.title === patch.title) &&
    (patch.readiness === undefined || current.readiness === patch.readiness) &&
    (patch.labels === undefined || equalSet(current.labels, patch.labels)) &&
    (patch.reviewer_refs === undefined || equalSet(current.reviewer_refs, patch.reviewer_refs));
}

function equalSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function mutationResponse<T>(
  value: T,
  key: string,
  replayed: boolean,
  http?: RemoteGitHttpResult
): RemoteGitMutationResponse<T> {
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
    return new RemoteGitProviderError(message, { kind: "conflict", operation, provider_id: "github" });
  }
  if (message.includes("local branch does not resolve")) {
    return new RemoteGitProviderError(message, { kind: "validation", operation, provider_id: "github" });
  }
  if (/repository not found/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "not_found", operation, provider_id: "github" });
  }
  if (/authentication failed|could not read username|invalid credentials/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "auth", operation, provider_id: "github" });
  }
  if (/permission denied|\b403\b/i.test(message)) {
    return new RemoteGitProviderError(message, { kind: "permission", operation, provider_id: "github" });
  }
  return normalizeProviderError(error, operation, "github");
}
