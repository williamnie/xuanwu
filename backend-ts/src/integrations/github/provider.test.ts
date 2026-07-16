import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type {
  RemoteGitCreatePullRequestRequest,
  RemoteGitPushBranchRequest,
  RemoteGitUpdatePullRequestRequest
} from "../git/remoteProvider.ts";
import { createMemoryRemoteGitMutationReceiptStore, type FetchLike, type RemoteGitAdapterAuditEvent } from "../git/adapterSupport.ts";
import {
  buildGitHubConnectorConfig,
  githubConnectorStatus,
  redactGitHubConnectorConfig
} from "./config.ts";
import { createGitHubRemoteGitProvider } from "./provider.ts";

const temporaryRoots: string[] = [];
const FIXTURE_REVISION = "a".repeat(40);

afterEach(async () => {
  while (temporaryRoots.length > 0) await rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("GitHub Handoff adapter", () => {
  test("reconciles a response-loss create, applies labels/reviewers, and round-trips draft to ready", async () => {
    const api = new FakeGitHubAPI();
    const audit: RemoteGitAdapterAuditEvent[] = [];
    const config = buildGitHubConnectorConfig({
      apiBaseUrl: "https://github.fixture.test",
      graphqlBaseUrl: "https://github.fixture.test/graphql",
      token: "provider-secret",
      tokenRef: "secret://github/handoff"
    });
    let loseCreateResponse = true;
    const lossyFetch: FetchLike = async (input, init) => {
      const response = await api.fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/pulls") && init?.method === "POST" && loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("network response lost TOKEN=provider-secret at /Users/fixture/private");
      }
      return response;
    };
    const firstProvider = createGitHubRemoteGitProvider({
      audit_sink: auditSink(audit), config, fetch: lossyFetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const request = createRequest();

    const firstError = await captureError(() => firstProvider.createPullRequest(request));
    expect(firstError).toMatchObject({ kind: "temporary", retryable: true });
    expect(firstError.message).not.toContain("provider-secret");
    expect(firstError.message).not.toContain("/Users/fixture/private");
    expect(api.createCount).toBe(1);

    const provider = createGitHubRemoteGitProvider({
      audit_sink: auditSink(audit), config, fetch: api.fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const recovered = await provider.createPullRequest(request);
    expect(recovered.idempotency).toEqual({ key: "create-pr-676", replayed: true });
    expect(recovered.value).toMatchObject({
      labels: ["handoff", "xuanwu"],
      pull_request_ref: "github:acme/demo#1",
      readiness: "draft",
      reviewer_refs: ["alice"]
    });
    expect(recovered.value.body).not.toContain("xuanwu-handoff-idempotency");
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
      reviewer_refs: ["bob"],
      title: "Ready adapter",
      body: "Updated body"
    });
    const read = await provider.readPullRequest({
      auth_ref: authRef(),
      pull_request_ref: recovered.value.pull_request_ref,
      repository: repository()
    });
    expect(read.value).toEqual(updated.value);
    expect(api.graphqlCount).toBe(1);
    expect(audit.filter((event) => event.event_type === "handoff.remote_git.attempt.v1")).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toContain("provider-secret");
  });

  test("maps rate limits and redacts token-bearing provider errors", async () => {
    const api = new FakeGitHubAPI();
    const config = buildGitHubConnectorConfig({ token: "provider-secret", tokenRef: "secret://github/handoff" });
    const provider = createGitHubRemoteGitProvider({
      audit_sink: auditSink([]), config, fetch: api.fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    api.rateLimitNext = true;

    const error = await captureError(() => provider.readPullRequest({
      auth_ref: authRef(),
      pull_request_ref: "github:acme/demo#1",
      repository: repository()
    }));

    expect(error).toMatchObject({ kind: "rate_limit", retryable: true, retry_after_seconds: 30, status_code: 429 });
    expect(error.rate_limit).toMatchObject({ remaining: 0, retry_after_seconds: 30 });
    expect(error.message).not.toContain("provider-secret");
    expect(error.message).not.toContain("/Users/fixture/private");
  });

  test("uses the real git CLI against a local bare sandbox with compare-and-set push", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-github-adapter-"));
    temporaryRoots.push(root);
    const local = join(root, "local");
    const remotes = join(root, "remotes");
    const bare = join(remotes, "acme", "demo.git");
    await mkdir(local, { recursive: true });
    await mkdir(join(remotes, "acme"), { recursive: true });
    git(["init", "--bare", "--initial-branch=main", bare]);
    git(["init", "-b", "main"], local);
    git(["config", "user.name", "Fixture"], local);
    git(["config", "user.email", "fixture@example.test"], local);
    await Bun.write(join(local, "README.md"), "sandbox\n");
    git(["add", "README.md"], local);
    git(["commit", "-m", "sandbox"], local);
    const commit = git(["rev-parse", "HEAD"], local).trim();
    const config = buildGitHubConnectorConfig({
      gitBaseUrl: `file://${remotes}`,
      token: "provider-secret",
      tokenRef: "secret://github/handoff"
    });
    const provider = createGitHubRemoteGitProvider({
      audit_sink: auditSink([]), config, fetch: new FakeGitHubAPI().fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const request: RemoteGitPushBranchRequest = {
      auth_ref: authRef(),
      commit_ref: commit,
      expected_remote_revision: null,
      local_branch_ref: "main",
      local_repository_path: local,
      remote_branch: "xw/676-adapter",
      repository: repository(),
      write: writeContext("push-676")
    };

    const pushed = await provider.pushBranch(request);
    const replayed = await provider.pushBranch(request);
    expect(pushed.value).toMatchObject({ before_revision: null, commit_ref: commit, outcome: "created" });
    expect(replayed.idempotency.replayed).toBe(true);
    expect(git(["rev-parse", "refs/heads/xw/676-adapter"], bare).trim()).toBe(commit);

    await Bun.write(join(local, "README.md"), "concurrent\n");
    git(["add", "README.md"], local);
    git(["commit", "-m", "concurrent"], local);
    const nextCommit = git(["rev-parse", "HEAD"], local).trim();
    const freshProvider = createGitHubRemoteGitProvider({
      audit_sink: auditSink([]), config, fetch: new FakeGitHubAPI().fetch, receipts: createMemoryRemoteGitMutationReceiptStore()
    });
    const conflict = await captureError(() => freshProvider.pushBranch({
      ...request,
      commit_ref: nextCommit,
      write: writeContext("push-conflict-676")
    }));
    expect(conflict).toMatchObject({ kind: "conflict", retryable: false });
    expect(git(["rev-parse", "refs/heads/xw/676-adapter"], bare).trim()).toBe(commit);
  });

  test("connector status and redacted config never expose token", () => {
    const configured = buildGitHubConnectorConfig({ token: "provider-secret" });
    expect(githubConnectorStatus(configured)).toMatchObject({
      auth_ref: "env://GITHUB_TOKEN",
      provider_id: "github",
      secrets: { token: { configured: true } },
      status: "configured"
    });
    expect(JSON.stringify(githubConnectorStatus(configured))).not.toContain("provider-secret");
    expect(JSON.stringify(redactGitHubConnectorConfig(configured))).not.toContain("provider-secret");
    expect(githubConnectorStatus(buildGitHubConnectorConfig()).status).toBe("disabled");
    expect(buildGitHubConnectorConfig({ webBaseUrl: "https://github.enterprise.test" })).toMatchObject({
      api_base_url: "https://github.enterprise.test/api/v3",
      git_base_url: "https://github.enterprise.test",
      graphql_base_url: "https://github.enterprise.test/api/graphql"
    });
  });
});

class FakeGitHubAPI {
  createCount = 0;
  graphqlCount = 0;
  rateLimitNext = false;
  private pulls: Array<Record<string, unknown>> = [];

  fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (this.rateLimitNext) {
      this.rateLimitNext = false;
      return json({ message: "TOKEN=provider-secret at /Users/fixture/private" }, 429, { "retry-after": "30", "x-ratelimit-remaining": "0" });
    }
    if (url.pathname === "/graphql" && method === "POST") {
      this.graphqlCount += 1;
      const body = jsonBody(init);
      const pull = this.pulls.find((item) => item.node_id === objectBody(body.variables).pullRequestId);
      if (pull) pull.draft = !String(body.query).includes("markPullRequestReadyForReview");
      return json({ data: { pullRequest: { id: pull?.node_id } } });
    }
    if (url.pathname.endsWith("/pulls") && method === "GET") return json(this.pulls);
    if (url.pathname.endsWith("/pulls") && method === "POST") {
      this.createCount += 1;
      const body = jsonBody(init);
      const pull = {
        base: { ref: body.base },
        body: body.body,
        draft: body.draft,
        head: { ref: body.head, sha: FIXTURE_REVISION },
        html_url: "https://github.fixture.test/acme/demo/pull/1",
        labels: [],
        merged_at: null,
        node_id: "PR_node_1",
        number: 1,
        requested_reviewers: [],
        state: "open",
        title: body.title,
        updated_at: "2026-07-17T08:00:00.000Z"
      };
      this.pulls.push(pull);
      return json(pull, 201);
    }
    if (url.pathname.endsWith("/issues/1/labels") && method === "PUT") {
      const labels = arrayStrings(jsonBody(init).labels);
      this.pull().labels = labels.map((name) => ({ name }));
      return json(this.pull().labels);
    }
    if (url.pathname.endsWith("/pulls/1/requested_reviewers") && method === "POST") {
      const add = arrayStrings(jsonBody(init).reviewers);
      const current = arrayObjects(this.pull().requested_reviewers).map((item) => String(item.login));
      this.pull().requested_reviewers = [...new Set([...current, ...add])].map((login) => ({ login }));
      return json(this.pull());
    }
    if (url.pathname.endsWith("/pulls/1/requested_reviewers") && method === "DELETE") {
      const remove = arrayStrings(jsonBody(init).reviewers);
      this.pull().requested_reviewers = arrayObjects(this.pull().requested_reviewers).filter((item) => !remove.includes(String(item.login)));
      return json(this.pull());
    }
    if (url.pathname.endsWith("/pulls/1") && method === "PATCH") {
      Object.assign(this.pull(), jsonBody(init), { updated_at: "2026-07-17T08:01:00.000Z" });
      return json(this.pull());
    }
    if (url.pathname.endsWith("/pulls/1") && method === "GET") return json(this.pull());
    return json({ message: `unhandled ${method} ${url.pathname}` }, 404);
  };

  private pull(): Record<string, unknown> {
    return this.pulls[0] ?? {
      base: { ref: "main" }, body: "", draft: false, head: { ref: "xw/676", sha: FIXTURE_REVISION },
      html_url: "https://github.fixture.test/acme/demo/pull/1", labels: [], merged_at: null, node_id: "PR_node_1",
      number: 1, requested_reviewers: [], state: "open", title: "Missing", updated_at: "2026-07-17T08:00:00.000Z"
    };
  }
}

function createRequest(): RemoteGitCreatePullRequestRequest {
  return {
    auth_ref: authRef(),
    base_branch: "main",
    body: "## Summary\nAdapter\nTOKEN=provider-secret at /Users/fixture/private",
    head_branch: "xw/676-adapter",
    head_revision: FIXTURE_REVISION,
    labels: ["handoff", "xuanwu"],
    readiness: "draft",
    repository: repository(),
    reviewer_refs: ["alice"],
    title: "Adapter",
    write: writeContext("create-pr-676")
  };
}

function updateRequest(pullRequestRef: string): RemoteGitUpdatePullRequestRequest {
  return {
    auth_ref: authRef(),
    patch: { body: "Updated body", labels: ["ready"], readiness: "ready", reviewer_refs: ["bob"], title: "Ready adapter" },
    pull_request_ref: pullRequestRef,
    repository: repository(),
    write: writeContext("update-pr-676")
  };
}

function authRef() {
  return { kind: "secret_ref" as const, provider_id: "github", ref: "secret://github/handoff" };
}

function repository() {
  return { provider_id: "github", repository_ref: "acme/demo" };
}

function writeContext(idempotencyKey: string) {
  return {
    actor: { id: "runner:fixture", kind: "runner" as const },
    authorization: { authority: "deterministic_policy" as const, decision: "allow" as const, policy_ref: "policy:handoff:test" },
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
      "x-github-request-id": "github-request-fixture",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": status === 429 ? "0" : "4999",
      "x-ratelimit-reset": "1784278860",
      ...headers
    },
    status
  });
}

function jsonBody(init: RequestInit): Record<string, any> {
  return JSON.parse(String(init.body ?? "{}"));
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectBody) : [];
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

async function captureError(action: () => Promise<unknown>): Promise<any> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to fail");
}
