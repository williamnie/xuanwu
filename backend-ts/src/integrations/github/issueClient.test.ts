import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitHubConnectorConfig } from "./config.ts";
import { buildConfig } from "../../config/env.ts";
import { createSecretService } from "../../security/secrets/service.ts";
import { buildGitHubIssueSyncConfig } from "./issueSyncConfig.ts";
import { createGitHubIssueTokenProvider, GitHubIssueApiError, GitHubIssueClient } from "./issueClient.ts";
import type { FetchLike } from "../git/adapterSupport.ts";

function client(fetch: FetchLike) { return new GitHubIssueClient({ apiBaseUrl: "https://api.github.com", token: async () => "test-secret-value", fetch }); }

describe("GitHub issue configuration and transport", () => {
  test("real Bun transport preserves HTTP 304 without following redirects", async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests++;
      if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "https://evil.invalid/collect" } });
      if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return Response.json([{ id: 1 }], { headers: { etag: '"v1"' } });
    } });
    try {
      const api = new GitHubIssueClient({ apiBaseUrl: `http://127.0.0.1:${server.port}`, token: async () => "local-fixture-token" });
      const first = await api.page("/issues");
      expect((await api.page("/issues", first.etag)).notModified).toBe(true);
      await expect(api.request("/redirect")).rejects.toThrow("302");
      expect(requests).toBe(3);
    } finally { server.stop(true); }
  });
  test("disabled by default, explicit bounded repository policy survives runtime config", () => {
    expect(buildGitHubIssueSyncConfig(undefined).enabled).toBe(false);
    const configured = buildConfig({ integrations: { github: { issueSync: { enabled: true,
      repositories: [{ repository: "Acme/Demo", projectId: "demo", autoEnqueue: true }] } } } }).integrations.github.issueSync;
    expect(configured.repositories[0]).toMatchObject({ repository: "acme/demo", autoEnqueue: true, allowFix: false, allowPullRequest: false, ciFailureMode: "repair" });
    expect(() => buildGitHubIssueSyncConfig({ repositories: [{ repository: "acme/demo", projectId: "demo", ciFailureMode: "report_only" }] })).toThrow();
    expect(buildGitHubIssueSyncConfig({ repositories: [{ repository: "acme/demo", projectId: "demo", ciFailureMode: "report_only", ciFailureReason: "Actions quota exhausted" }] }).repositories[0]?.ciFailureMode).toBe("report_only");
    expect(() => buildGitHubIssueSyncConfig({ enabled: true })).toThrow();
    expect(() => buildGitHubIssueSyncConfig({ repositories: [{ repository: "../secret", projectId: "demo" }] })).toThrow();
    expect(() => buildGitHubIssueSyncConfig({ jev: { minConfidence: 0 } })).toThrow();
    expect(() => buildGitHubIssueSyncConfig({ auth: { mode: "github-app" } })).toThrow();
  });

  test("follows pagination in API root, sends conditional headers and respects 304", async () => {
    const requests: string[] = [];
    const api = client(async (url, init) => {
      requests.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret-value");
      expect(init?.redirect).toBe("manual");
      if (new Headers(init?.headers).has("if-none-match")) return new Response(null, { status: 304 });
      if (String(url).endsWith("page=2")) return Response.json([{ id: 2 }]);
      return Response.json([{ id: 1 }], { headers: { link: '<https://api.github.com/repos/a/b/issues?page=2>; rel="next"', etag: '"v1"' } });
    });
    expect(await api.all("/repos/a/b/issues")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await api.page("/repos/a/b/issues", '"v1"')).toMatchObject({ notModified: true, etag: '"v1"' });
    expect(requests).toHaveLength(3);
  });

  test("rejects hostile pagination before sending credentials and detects pagination loops", async () => {
    let calls = 0;
    const api = client(async () => {
      calls++;
      return Response.json([], { headers: { link: '<https://evil.invalid/collect>; rel="next"' } });
    });
    await expect(api.all("/repos/a/b/issues")).rejects.toThrow("outside");
    await expect(api.request("https://evil.invalid")).rejects.toThrow("outside");
    expect(calls).toBe(1);
    const loop = client(async () => Response.json([], { headers: { link: '<https://api.github.com/items>; rel="next"' } }));
    await expect(loop.all("https://api.github.com/items")).rejects.toThrow("pagination limit");
  });

  test("redacts upstream failures and exposes a durable rate-limit cooldown", async () => {
    const api = client(async () => new Response("echo secret test-secret-value", { status: 429, headers: { "retry-after": "90" } }));
    try { await api.request("/repos/a/b/issues"); throw new Error("should reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(GitHubIssueApiError);
      expect((error as GitHubIssueApiError).retryAfterSeconds).toBe(90);
      expect((error as GitHubIssueApiError).retryable).toBe(true);
      expect(String(error)).not.toContain("secret");
    }
    const huge = client(async () => new Response("x", { headers: { "content-length": "99999999" } }));
    await expect(huge.request("/items")).rejects.toThrow("502");
  });

  test("GitHub App signs short-lived JWT and shares a cached installation token", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-github-app-"));
    try {
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const secret = createSecretService({ stateDir: root, backend: "file" }).put("github/app", pem, "test", "test app key");
      const config = buildGitHubConnectorConfig({ issueSync: { auth: {
        mode: "github-app", appId: "app-test", installationId: "12", privateKeyRef: secret.ref
      } } });
      let calls = 0;
      const token = createGitHubIssueTokenProvider(config, root, async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://api.github.com/app/installations/12/access_tokens");
        const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
        const [header, payload, signature] = jwt.split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
        expect(claims.iss).toBe("app-test");
        expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
        return Response.json({ token: "installation-test-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
      });
      expect(await Promise.all([token(), token()])).toEqual(["installation-test-token", "installation-test-token"]);
      expect(await token()).toBe("installation-test-token");
      expect(calls).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
