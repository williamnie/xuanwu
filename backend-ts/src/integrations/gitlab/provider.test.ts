import { describe, expect, test } from "bun:test";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type { RemoteGitCreatePullRequestRequest, RemoteGitUpdatePullRequestRequest } from "../git/remoteProvider.ts";
import { createMemoryRemoteGitMutationReceiptStore, type FetchLike, type RemoteGitAdapterAuditEvent } from "../git/adapterSupport.ts";
import {
  buildGitLabConnectorConfig,
  gitlabConnectorStatus,
  redactGitLabConnectorConfig
} from "./config.ts";
import { createGitLabRemoteGitProvider } from "./provider.ts";

const FIXTURE_REVISION = "b".repeat(40);

describe("GitLab Handoff adapter", () => {
  test("uses the same provider contract and safely reconciles a response-loss MR create", async () => {
    const api = new FakeGitLabAPI();
    const audit: RemoteGitAdapterAuditEvent[] = [];
    const config = buildGitLabConnectorConfig({
      apiBaseUrl: "https://gitlab.fixture.test/api/v4",
      token: "provider-secret",
      tokenRef: "secret://gitlab/handoff"
    });
    let loseCreateResponse = true;
    const lossyFetch: FetchLike = async (input, init) => {
      const response = await api.fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/merge_requests") && init?.method === "POST" && loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("GITLAB_TOKEN=provider-secret at /Users/fixture/private");
      }
      return response;
    };
    const request = createRequest();
    const first = createGitLabRemoteGitProvider({
      audit_sink: auditSink(audit), config, fetch: lossyFetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const firstError = await captureError(() => first.createPullRequest(request));
    expect(firstError).toMatchObject({ kind: "temporary", retryable: true });
    expect(firstError.message).not.toContain("provider-secret");
    expect(api.createCount).toBe(1);

    const provider = createGitLabRemoteGitProvider({
      audit_sink: auditSink(audit), config, fetch: api.fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const recovered = await provider.createPullRequest(request);
    expect(recovered.idempotency).toEqual({ key: "gitlab-create-676", replayed: true });
    expect(recovered.value).toMatchObject({
      labels: ["handoff", "xuanwu"],
      pull_request_ref: "gitlab:group/platform/demo!1",
      readiness: "draft",
      reviewer_refs: ["101"]
    });
    expect(recovered.value.title).toBe("Adapter");
    expect(recovered.value.body).not.toContain("provider-secret");
    expect(recovered.value.body).not.toContain("/Users/fixture/private");
    expect(api.createCount).toBe(1);

    const conflict = await captureError(() => provider.createPullRequest({ ...request, title: "Different mutation" }));
    expect(conflict).toMatchObject({ kind: "idempotency_conflict", retryable: false });
    expect(api.createCount).toBe(1);

    const updated = await provider.updatePullRequest(updateRequest(recovered.value.pull_request_ref));
    expect(updated.value).toMatchObject({
      labels: ["ready"],
      readiness: "ready",
      reviewer_refs: ["202"],
      title: "Ready adapter",
      body: "Updated body"
    });
    const read = await provider.readPullRequest({
      auth_ref: authRef(),
      pull_request_ref: recovered.value.pull_request_ref,
      repository: repository()
    });
    expect(read.value).toEqual(updated.value);
    expect(JSON.stringify(audit)).not.toContain("provider-secret");
  });

  test("maps GitLab throttling and keeps connector status redacted", async () => {
    const api = new FakeGitLabAPI();
    const config = buildGitLabConnectorConfig({ token: "provider-secret", tokenRef: "secret://gitlab/handoff" });
    const provider = createGitLabRemoteGitProvider({
      audit_sink: auditSink([]), config, fetch: api.fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    api.rateLimitNext = true;

    const error = await captureError(() => provider.readPullRequest({
      auth_ref: authRef(),
      pull_request_ref: "gitlab:group/platform/demo!1",
      repository: repository()
    }));
    expect(error).toMatchObject({ kind: "rate_limit", retryable: true, retry_after_seconds: 45, status_code: 429 });
    expect(error.message).not.toContain("provider-secret");
    expect(error.message).not.toContain("/Users/fixture/private");

    expect(gitlabConnectorStatus(config)).toMatchObject({
      auth_ref: "secret://gitlab/handoff",
      provider_id: "gitlab",
      secrets: { token: { configured: true } },
      status: "configured"
    });
    expect(JSON.stringify(gitlabConnectorStatus(config))).not.toContain("provider-secret");
    expect(JSON.stringify(redactGitLabConnectorConfig(config))).not.toContain("provider-secret");
    expect(gitlabConnectorStatus(buildGitLabConnectorConfig()).status).toBe("disabled");
    expect(buildGitLabConnectorConfig({ webBaseUrl: "https://gitlab.self-managed.test" })).toMatchObject({
      api_base_url: "https://gitlab.self-managed.test/api/v4",
      git_base_url: "https://gitlab.self-managed.test"
    });
  });
});

class FakeGitLabAPI {
  createCount = 0;
  rateLimitNext = false;
  private mergeRequests: Array<Record<string, unknown>> = [];

  fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (this.rateLimitNext) {
      this.rateLimitNext = false;
      return json({ message: "GITLAB_TOKEN=provider-secret at /Users/fixture/private" }, 429, {
        "ratelimit-remaining": "0", "retry-after": "45"
      });
    }
    if (url.pathname.endsWith("/merge_requests") && method === "GET") return json(this.mergeRequests);
    if (url.pathname.endsWith("/merge_requests") && method === "POST") {
      this.createCount += 1;
      const body = jsonBody(init);
      const mergeRequest = {
        description: body.description,
        draft: String(body.title).startsWith("Draft:"),
        iid: 1,
        labels: csv(body.labels),
        reviewers: arrayNumbers(body.reviewer_ids).map((id) => ({ id })),
        sha: FIXTURE_REVISION,
        source_branch: body.source_branch,
        state: "opened",
        target_branch: body.target_branch,
        title: body.title,
        updated_at: "2026-07-17T08:00:00.000Z",
        web_url: "https://gitlab.fixture.test/group/platform/demo/-/merge_requests/1"
      };
      this.mergeRequests.push(mergeRequest);
      return json(mergeRequest, 201);
    }
    if (url.pathname.endsWith("/merge_requests/1") && method === "PUT") {
      const body = jsonBody(init);
      const current = this.mergeRequest();
      if (body.description !== undefined) current.description = body.description;
      if (body.labels !== undefined) current.labels = csv(body.labels);
      if (body.reviewer_ids !== undefined) current.reviewers = arrayNumbers(body.reviewer_ids).map((id) => ({ id }));
      if (body.title !== undefined) {
        current.title = body.title;
        current.draft = String(body.title).startsWith("Draft:");
      }
      current.updated_at = "2026-07-17T08:01:00.000Z";
      return json(current);
    }
    if (url.pathname.endsWith("/merge_requests/1") && method === "GET") return json(this.mergeRequest());
    return json({ message: `unhandled ${method} ${url.pathname}` }, 404);
  };

  private mergeRequest(): Record<string, unknown> {
    return this.mergeRequests[0] ?? {
      description: "", draft: false, iid: 1, labels: [], reviewers: [], sha: FIXTURE_REVISION,
      source_branch: "xw/676", state: "opened", target_branch: "main", title: "Missing",
      updated_at: "2026-07-17T08:00:00.000Z", web_url: "https://gitlab.fixture.test/group/platform/demo/-/merge_requests/1"
    };
  }
}

function createRequest(): RemoteGitCreatePullRequestRequest {
  return {
    auth_ref: authRef(),
    base_branch: "main",
    body: "## Summary\nAdapter\nGITLAB_TOKEN=provider-secret at /Users/fixture/private",
    head_branch: "xw/676-adapter",
    head_revision: FIXTURE_REVISION,
    labels: ["handoff", "xuanwu"],
    readiness: "draft",
    repository: repository(),
    reviewer_refs: ["101"],
    title: "Adapter",
    write: writeContext("gitlab-create-676")
  };
}

function updateRequest(pullRequestRef: string): RemoteGitUpdatePullRequestRequest {
  return {
    auth_ref: authRef(),
    patch: { body: "Updated body", labels: ["ready"], readiness: "ready", reviewer_refs: ["202"], title: "Ready adapter" },
    pull_request_ref: pullRequestRef,
    repository: repository(),
    write: writeContext("gitlab-update-676")
  };
}

function authRef() {
  return { kind: "secret_ref" as const, provider_id: "gitlab", ref: "secret://gitlab/handoff" };
}

function repository() {
  return { provider_id: "gitlab", repository_ref: "group/platform/demo" };
}

function writeContext(idempotencyKey: string) {
  return {
    actor: { id: "runner:fixture", kind: "runner" as const },
    authorization: { authority: "human_approval" as const, decision: "allow" as const, policy_ref: "approval:handoff:test" },
    correlation_id: `correlation:${idempotencyKey}`,
    handoff_id: makeDomainID("handoff", "derived", "676@commit-676"),
    idempotency_key: idempotencyKey,
    intent_event_ref: `event:intent:${idempotencyKey}`,
    work_id: makeDomainID("work", "issues", "676")
  };
}

function auditSink(events: RemoteGitAdapterAuditEvent[]) {
  return { async record(event: RemoteGitAdapterAuditEvent) { events.push(event); } };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, {
    headers: {
      "ratelimit-limit": "2000",
      "ratelimit-remaining": status === 429 ? "0" : "1999",
      "ratelimit-reset": "1784278860",
      "x-request-id": "gitlab-request-fixture",
      ...headers
    },
    status
  });
}

function jsonBody(init: RequestInit): Record<string, any> {
  return JSON.parse(String(init.body ?? "{}"));
}

function csv(value: unknown): string[] {
  return String(value ?? "").split(",").filter(Boolean);
}

function arrayNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number) : [];
}

async function captureError(action: () => Promise<unknown>): Promise<any> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to fail");
}
