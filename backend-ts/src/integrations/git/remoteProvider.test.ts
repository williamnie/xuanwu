import { describe, expect, test } from "bun:test";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
  RemoteGitIdempotencyConflictError,
  RemoteGitProviderError,
  RemoteGitRateLimitError,
  assertRemoteGitAuthRef,
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
} from "./remoteProvider.ts";

describe("Remote Git provider contract", () => {
  test("pushes a branch and exposes rate-limit metadata without binding to GitHub or GitLab", async () => {
    const provider: RemoteGitProvider = new FakeRemoteGitProvider();
    const request = pushRequest("push-1");

    const created = await provider.pushBranch(request);
    const replayed = await provider.pushBranch(request);

    expect(provider.descriptor).toEqual({
      contract_version: REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
      display_name: "Fixture Git",
      provider_id: "fixture"
    });
    expect(created.value).toMatchObject({
      before_revision: null,
      commit_ref: "commit-1",
      outcome: "created",
      remote_branch: "xw/675-provider",
      remote_ref: "fixture:repo:xw/675-provider"
    });
    expect(created.rate_limit).toEqual({ limit: 100, remaining: 99, resource: "git", reset_at: NOW });
    expect(replayed.idempotency).toEqual({ key: "push-1", replayed: true });
    expect(replayed.value).toEqual(created.value);
  });

  test("creates a draft once for repeated requests, then updates and reads it as ready", async () => {
    const provider = new FakeRemoteGitProvider();
    const create = pullRequest("create-pr-1");

    const first = await provider.createPullRequest(create);
    const duplicate = await provider.createPullRequest(create);

    expect(provider.pullRequestCreateCount).toBe(1);
    expect(first.idempotency).toEqual({ key: "create-pr-1", replayed: false });
    expect(duplicate.idempotency).toEqual({ key: "create-pr-1", replayed: true });
    expect(duplicate.value.pull_request_ref).toBe(first.value.pull_request_ref);
    expect(first.value.readiness).toBe("draft");

    const updated = await provider.updatePullRequest({
      auth_ref: authRef(),
      patch: { readiness: "ready", reviewer_refs: ["team:reviewers"] },
      pull_request_ref: first.value.pull_request_ref,
      repository: repository(),
      write: writeContext("ready-pr-1")
    });
    const read = await provider.readPullRequest({
      auth_ref: authRef(),
      pull_request_ref: first.value.pull_request_ref,
      repository: repository()
    });

    expect(updated.value).toMatchObject({ readiness: "ready", reviewer_refs: ["team:reviewers"] });
    expect(read.value).toEqual(updated.value);
    expect(read).not.toHaveProperty("idempotency");
  });

  test("rejects reusing a create idempotency key for a different mutation", async () => {
    const provider = new FakeRemoteGitProvider();
    await provider.createPullRequest(pullRequest("create-pr-conflict"));

    const error = await captureError(() => provider.createPullRequest({
      ...pullRequest("create-pr-conflict"),
      title: "different title"
    }));

    expect(error).toBeInstanceOf(RemoteGitIdempotencyConflictError);
    expect(error).toMatchObject({
      idempotency_key: "create-pr-conflict",
      kind: "idempotency_conflict",
      operation: "create_pull_request",
      retryable: false
    });
    expect(provider.pullRequestCreateCount).toBe(1);
  });

  test("fails closed on raw credential fields and non-authoritative write decisions", () => {
    expect(() => assertRemoteGitAuthRef({
      kind: "secret_ref",
      provider_id: "fixture",
      ref: "secret://fixture/git",
      token: "must-not-be-accepted"
    }, "fixture", "read_pull_request")).toThrow("auth_ref contains unsupported fields: token");

    expect(() => assertRemoteGitWriteContext({
      ...writeContext("denied-write"),
      authorization: {
        authority: "llm",
        decision: "allow",
        policy_ref: "model-output:fixture"
      }
    }, "push_branch")).toThrow("write.authorization.authority is not trusted");

    expect(() => assertRemoteGitWriteContext({
      ...writeContext("ask-write"),
      authorization: {
        authority: "human_approval",
        decision: "ask",
        policy_ref: "approval:fixture"
      }
    }, "create_pull_request")).toThrow("remote Git writes require an allow decision");
  });

  test("uses typed retryable rate-limit errors and redacts sensitive provider text", () => {
    const error = new RemoteGitRateLimitError(
      "TOKEN=provider-secret retry later at /Users/fixture/private",
      {
        operation: "create_pull_request",
        provider_id: "fixture",
        rate_limit: { remaining: 0, reset_at: NOW, retry_after_seconds: 45 },
        status_code: 429
      }
    );

    expect(error).toBeInstanceOf(RemoteGitProviderError);
    expect(error).toMatchObject({
      kind: "rate_limit",
      operation: "create_pull_request",
      retry_after_seconds: 45,
      retryable: true,
      status_code: 429
    });
    expect(error.message).not.toContain("provider-secret");
    expect(error.message).not.toContain("/Users/fixture/private");
  });
});

const NOW = "2026-07-17T08:00:00.000Z";

class FakeRemoteGitProvider implements RemoteGitProvider {
  readonly descriptor = {
    contract_version: REMOTE_GIT_PROVIDER_CONTRACT_VERSION,
    display_name: "Fixture Git",
    provider_id: "fixture"
  } as const;
  pullRequestCreateCount = 0;

  private readonly createReceipts = new Map<string, { fingerprint: string; value: RemoteGitPullRequest }>();
  private readonly pullRequests = new Map<string, RemoteGitPullRequest>();
  private readonly pushReceipts = new Map<string, { fingerprint: string; value: RemoteGitPushResult }>();
  private readonly remoteBranches = new Map<string, string>();
  private readonly updateReceipts = new Map<string, { fingerprint: string; value: RemoteGitPullRequest }>();

  async pushBranch(request: RemoteGitPushBranchRequest): Promise<RemoteGitMutationResponse<RemoteGitPushResult>> {
    this.validateWriteRequest(request, "push_branch");
    const fingerprint = JSON.stringify({
      commit_ref: request.commit_ref,
      expected_remote_revision: request.expected_remote_revision,
      local_branch_ref: request.local_branch_ref,
      local_repository_path: request.local_repository_path,
      remote_branch: request.remote_branch,
      repository: request.repository
    });
    const receiptKey = this.receiptKey(request.repository.repository_ref, request.write.idempotency_key);
    const replay = this.pushReceipts.get(receiptKey);
    if (replay) return this.replayOrConflict(replay, fingerprint, request.write.idempotency_key, "push_branch");

    const branchKey = `${request.repository.repository_ref}:${request.remote_branch}`;
    const before = this.remoteBranches.get(branchKey) ?? null;
    if (before !== request.commit_ref && before !== request.expected_remote_revision) {
      throw new RemoteGitProviderError("remote branch changed after preflight", {
        kind: "conflict",
        operation: "push_branch",
        provider_id: this.descriptor.provider_id
      });
    }
    const value: RemoteGitPushResult = {
      before_revision: before,
      commit_ref: request.commit_ref,
      outcome: before === request.commit_ref ? "unchanged" : before === null ? "created" : "updated",
      remote_branch: request.remote_branch,
      remote_ref: `${this.descriptor.provider_id}:${request.repository.repository_ref}:${request.remote_branch}`
    };
    this.remoteBranches.set(branchKey, request.commit_ref);
    this.pushReceipts.set(receiptKey, { fingerprint, value });
    return this.mutation(value, request.write.idempotency_key, false);
  }

  async createPullRequest(
    request: RemoteGitCreatePullRequestRequest
  ): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>> {
    this.validateWriteRequest(request, "create_pull_request");
    const fingerprint = JSON.stringify({
      base_branch: request.base_branch,
      body: request.body,
      head_branch: request.head_branch,
      head_revision: request.head_revision,
      labels: request.labels ?? [],
      readiness: request.readiness,
      repository: request.repository,
      reviewer_refs: request.reviewer_refs ?? [],
      title: request.title
    });
    const receiptKey = this.receiptKey(request.repository.repository_ref, request.write.idempotency_key);
    const replay = this.createReceipts.get(receiptKey);
    if (replay) return this.replayOrConflict(replay, fingerprint, request.write.idempotency_key, "create_pull_request");

    this.pullRequestCreateCount += 1;
    const pullRequestRef = `fixture:pr:${this.pullRequestCreateCount}`;
    const value: RemoteGitPullRequest = {
      base_branch: request.base_branch,
      body: request.body,
      head_branch: request.head_branch,
      head_revision: request.head_revision,
      labels: [...request.labels ?? []],
      lifecycle: "open",
      pull_request_ref: pullRequestRef,
      readiness: request.readiness,
      repository_ref: request.repository.repository_ref,
      reviewer_refs: [...request.reviewer_refs ?? []],
      title: request.title,
      updated_at: NOW,
      url: `https://fixture.invalid/pr/${this.pullRequestCreateCount}`
    };
    this.pullRequests.set(pullRequestRef, value);
    this.createReceipts.set(receiptKey, { fingerprint, value });
    return this.mutation(value, request.write.idempotency_key, false);
  }

  async updatePullRequest(
    request: RemoteGitUpdatePullRequestRequest
  ): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>> {
    this.validateWriteRequest(request, "update_pull_request");
    const fingerprint = JSON.stringify({
      patch: request.patch,
      pull_request_ref: request.pull_request_ref,
      repository: request.repository
    });
    const receiptKey = this.receiptKey(request.repository.repository_ref, request.write.idempotency_key);
    const replay = this.updateReceipts.get(receiptKey);
    if (replay) return this.replayOrConflict(replay, fingerprint, request.write.idempotency_key, "update_pull_request");
    if (Object.keys(request.patch).length === 0) {
      throw new RemoteGitProviderError("pull request patch must not be empty", {
        kind: "validation",
        operation: "update_pull_request",
        provider_id: this.descriptor.provider_id
      });
    }
    const current = this.pullRequests.get(request.pull_request_ref);
    if (!current) {
      throw new RemoteGitProviderError("pull request not found", {
        kind: "not_found",
        operation: "update_pull_request",
        provider_id: this.descriptor.provider_id
      });
    }
    const value: RemoteGitPullRequest = {
      ...current,
      ...request.patch,
      labels: request.patch.labels ? [...request.patch.labels] : current.labels,
      reviewer_refs: request.patch.reviewer_refs ? [...request.patch.reviewer_refs] : current.reviewer_refs,
      updated_at: NOW
    };
    this.pullRequests.set(request.pull_request_ref, value);
    this.updateReceipts.set(receiptKey, { fingerprint, value });
    return this.mutation(value, request.write.idempotency_key, false);
  }

  async readPullRequest(request: RemoteGitReadPullRequestRequest): Promise<RemoteGitProviderResponse<RemoteGitPullRequest>> {
    this.validateRepository(request.auth_ref, request.repository, "read_pull_request");
    const value = this.pullRequests.get(request.pull_request_ref);
    if (!value) {
      throw new RemoteGitProviderError("pull request not found", {
        kind: "not_found",
        operation: "read_pull_request",
        provider_id: this.descriptor.provider_id
      });
    }
    return { provider_request_ref: "fixture:request:read", rate_limit: this.rateLimit(), value };
  }

  private validateWriteRequest(
    request: Pick<RemoteGitPushBranchRequest, "auth_ref" | "repository" | "write">,
    operation: "push_branch" | "create_pull_request" | "update_pull_request"
  ): void {
    this.validateRepository(request.auth_ref, request.repository, operation);
    assertRemoteGitWriteContext(request.write, operation);
  }

  private validateRepository(
    authRef: RemoteGitReadPullRequestRequest["auth_ref"],
    repository: RemoteGitReadPullRequestRequest["repository"],
    operation: "push_branch" | "create_pull_request" | "update_pull_request" | "read_pull_request"
  ): void {
    assertRemoteGitAuthRef(authRef, this.descriptor.provider_id, operation);
    if (repository.provider_id !== this.descriptor.provider_id || repository.repository_ref.trim() === "") {
      throw new RemoteGitProviderError("repository does not match the provider", {
        kind: "validation",
        operation,
        provider_id: this.descriptor.provider_id
      });
    }
  }

  private mutation<T>(value: T, key: string, replayed: boolean): RemoteGitMutationResponse<T> {
    return {
      idempotency: { key, replayed },
      provider_request_ref: `fixture:request:${key}`,
      rate_limit: this.rateLimit(),
      value
    };
  }

  private receiptKey(repositoryRef: string, idempotencyKey: string): string {
    return `${this.descriptor.provider_id}:${repositoryRef}:${idempotencyKey}`;
  }

  private replayOrConflict<T>(
    receipt: { fingerprint: string; value: T },
    fingerprint: string,
    key: string,
    operation: "push_branch" | "create_pull_request" | "update_pull_request"
  ): RemoteGitMutationResponse<T> {
    if (receipt.fingerprint !== fingerprint) {
      throw new RemoteGitIdempotencyConflictError("idempotency key is already bound to another mutation", {
        idempotency_key: key,
        operation,
        provider_id: this.descriptor.provider_id
      });
    }
    return this.mutation(receipt.value, key, true);
  }

  private rateLimit() {
    return { limit: 100, remaining: 99, resource: "git", reset_at: NOW };
  }
}

function authRef() {
  return { kind: "secret_ref", provider_id: "fixture", ref: "secret://fixture/git" } as const;
}

function repository() {
  return { provider_id: "fixture", repository_ref: "repo" };
}

function writeContext(idempotencyKey: string) {
  return {
    actor: { id: "runner:fixture", kind: "runner" },
    authorization: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: "project-policy:fixture:remote-git@1"
    },
    correlation_id: `correlation:${idempotencyKey}`,
    handoff_id: makeDomainID("handoff", "derived", `675:${idempotencyKey}`),
    idempotency_key: idempotencyKey,
    intent_event_ref: `issue-event:675:${idempotencyKey}:intent`,
    work_id: makeDomainID("work", "issues", 675)
  } as const;
}

function pushRequest(idempotencyKey: string): RemoteGitPushBranchRequest {
  return {
    auth_ref: authRef(),
    commit_ref: "commit-1",
    expected_remote_revision: null,
    local_branch_ref: "refs/heads/xw/675-provider",
    local_repository_path: "/fixture/repo",
    remote_branch: "xw/675-provider",
    repository: repository(),
    write: writeContext(idempotencyKey)
  };
}

function pullRequest(idempotencyKey: string): RemoteGitCreatePullRequestRequest {
  return {
    auth_ref: authRef(),
    base_branch: "main",
    body: "Validated handoff",
    head_branch: "xw/675-provider",
    head_revision: "commit-1",
    readiness: "draft",
    repository: repository(),
    title: "Define remote provider contract",
    write: writeContext(idempotencyKey)
  };
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected function to throw");
}
