import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import { validateEvidence } from "./contracts.ts";
import {
  FileSystemHttpEvidenceArtifactStore,
  createHttpEvidenceInvocation,
  createHttpEvidenceVerifier,
  type HttpEvidenceAssertion,
  type HttpEvidenceRequestSpec,
  type VerifyHttpEvidenceInput
} from "./httpVerifier.ts";

const COLLECTED_AT = "2026-07-16T11:00:00.000Z";
const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("HTTP Evidence verifier", () => {
  test("verifies health, status, headers, JSON schema and business facts with structured provenance", async () => {
    const fixture = startFixtureServer();
    const stateDir = temporaryDirectory();
    const verifier = createHttpEvidenceVerifier({
      artifact_store: new FileSystemHttpEvidenceArtifactStore(stateDir)
    });
    const evidence = await verifier.verify(input({
      headers: {
        Authorization: "Bearer request-secret",
        "X-API-Key": "request-api-secret"
      },
      url: `${fixtureUrl(fixture.server, "/healthy")}?access_token=url-secret`
    }, [
      { kind: "health", label: "health endpoint" },
      { expected: 200, kind: "status_code", label: "status" },
      { expected: "2026.07", kind: "header", name: "x-service-version", operator: "equals" },
      {
        kind: "json_schema",
        schema: {
          additionalProperties: true,
          properties: {
            api_key: { type: "string" },
            ready: { type: "boolean" },
            service: {
              properties: { name: { minLength: 1, type: "string" } },
              required: ["name"],
              type: "object"
            },
            status: { enum: ["ok", "degraded"] }
          },
          required: ["status", "ready", "service"],
          type: "object"
        }
      },
      { kind: "business", operator: "truthy", path: "$.ready" },
      { expected: "fixture", kind: "business", operator: "equals", path: "$.service.name" }
    ]));

    expect(evidence).toMatchObject({
      kind: "http",
      status: "passed",
      decisive_output: {
        facts: {
          artifact_written: true,
          assertion_count: 6,
          failed_assertion_count: 0,
          outcome: "passed",
          passed_assertion_count: 6,
          response_status: 200,
          retry_attempt_count: 1
        }
      },
      provenance: {
        assertion_origin: "system_observation",
        source_kind: "http_exchange",
        source_ref: "http-fixture:666"
      }
    });
    expect(evidence.decisive_output.summary).toContain("6/6 assertions passed");
    expect(validateEvidence(evidence)).toMatchObject({ known_kind: true, ok: true });
    expect(fixture.observed.authorization).toBe("Bearer request-secret");
    expect(fixture.observed.apiKey).toBe("request-api-secret");

    const artifact = evidence.artifact_refs[0]!;
    const stored = readFileSync(join(stateDir, artifact.ref), "utf8");
    expect(artifact).toMatchObject({ kind: "report", media_type: "application/json" });
    expect(statSync(join(stateDir, artifact.ref)).mode & 0o777).toBe(0o600);
    expect(stored).toContain("[redacted]");
    for (const secret of [
      "request-secret",
      "request-api-secret",
      "response-cookie-secret",
      "response-secret",
      "body-secret",
      "url-secret"
    ]) {
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(evidence)).not.toContain(secret);
    }
    expect(Number(evidence.decisive_output.facts.artifact_redaction_count)).toBeGreaterThanOrEqual(4);
  });

  test("returns actionable failures for status, header, schema and business assertion mismatches", async () => {
    const fixture = startFixtureServer();
    const evidence = await createHttpEvidenceVerifier().verify(input({
      url: fixtureUrl(fixture.server, "/unhealthy")
    }, [
      { kind: "health" },
      { expected: 200, kind: "status_code" },
      { kind: "header", name: "x-required", operator: "exists" },
      {
        kind: "json_schema",
        schema: {
          properties: { ready: { type: "boolean" } },
          required: ["ready"],
          type: "object"
        }
      },
      { expected: true, kind: "business", operator: "equals", path: "$.ready" }
    ]));
    const results = JSON.parse(String(evidence.decisive_output.facts.assertion_results_json));

    expect(evidence.status).toBe("failed");
    expect(evidence.decisive_output.summary).toContain("health endpoint expected HTTP 2xx, received 503");
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "status_code", message: expect.stringContaining("expected [200], received 503"), passed: false }),
      expect.objectContaining({ kind: "header", message: expect.stringContaining("header was missing"), passed: false }),
      expect.objectContaining({ kind: "json_schema", message: expect.stringContaining("$.ready: expected type boolean"), passed: false }),
      expect.objectContaining({ kind: "business", message: expect.stringContaining("resolved value did not match"), passed: false })
    ]));
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  test("retries bounded transient statuses and timeouts without trusting a late response", async () => {
    const fixture = startFixtureServer();
    const verifier = createHttpEvidenceVerifier();
    const retried = await verifier.verify(input({
      retry: { backoff_ms: 0, max_attempts: 3, retry_on_statuses: [503] },
      url: fixtureUrl(fixture.server, "/flaky")
    }, [{ kind: "health" }]));

    expect(retried).toMatchObject({
      status: "passed",
      decisive_output: { facts: { response_status: 200, retry_attempt_count: 3 } }
    });
    expect(fixture.observed.flakyRequests).toBe(3);

    const timedOut = await verifier.verify(input({
      retry: { backoff_ms: 0, max_attempts: 2, retry_on_timeout: true },
      timeout_ms: 10,
      url: fixtureUrl(fixture.server, "/slow")
    }, [{ kind: "health" }], "timeout"));
    expect(timedOut).toMatchObject({
      status: "failed",
      decisive_output: { facts: { outcome: "timeout", retry_attempt_count: 2, response_status: null } }
    });
    expect(timedOut.decisive_output.summary).toContain("timed out after 10 ms");
    expect(validateEvidence(timedOut).ok).toBe(true);
  });

  test("bounds response capture, requires an artifact for inline overflow, and fails closed for truncated JSON", async () => {
    const fixture = startFixtureServer();
    const request = { max_response_bytes: 512, url: fixtureUrl(fixture.server, "/large-json") };
    await expect(createHttpEvidenceVerifier({ max_inline_body_bytes: 256 }).verify(input(
      request,
      [{ expected: 200, kind: "status_code" }]
    ))).rejects.toThrow("no artifact store was provided");

    const stateDir = temporaryDirectory();
    const evidence = await createHttpEvidenceVerifier({
      artifact_store: new FileSystemHttpEvidenceArtifactStore(stateDir),
      max_inline_body_bytes: 256
    }).verify(input(request, [
      { expected: 200, kind: "status_code" },
      {
        kind: "json_schema",
        schema: { properties: { ready: { type: "boolean" } }, required: ["ready"], type: "object" }
      }
    ]));
    const results = JSON.parse(String(evidence.decisive_output.facts.assertion_results_json));

    expect(evidence).toMatchObject({
      status: "failed",
      decisive_output: {
        facts: {
          response_body_bytes: 512,
          response_truncated: true
        }
      }
    });
    expect(Buffer.byteLength(evidence.decisive_output.excerpt ?? "")).toBeLessThanOrEqual(256);
    expect(results).toContainEqual(expect.objectContaining({
      kind: "json_schema",
      message: "response body was truncated before JSON assertions could run",
      passed: false
    }));
    expect(evidence.artifact_refs).toHaveLength(1);
  });

  test("rejects write permission or mutating methods before any network request", async () => {
    const fixture = startFixtureServer();
    const verifier = createHttpEvidenceVerifier();
    const readInput = input({ url: fixtureUrl(fixture.server, "/healthy") }, [{ kind: "health" }]);
    await expect(verifier.verify({
      ...readInput,
      invocation: { ...readInput.invocation, permission: "write" }
    })).rejects.toThrow("requires the read tool permission envelope");

    const post = input({
      method: "POST" as never,
      url: fixtureUrl(fixture.server, "/healthy")
    }, [{ kind: "health" }], "post");
    await expect(verifier.verify(post)).rejects.toThrow("only permits GET and HEAD");
    expect(fixture.observed.totalRequests).toBe(0);
  });
});

function input(
  request: HttpEvidenceRequestSpec,
  assertions: readonly HttpEvidenceAssertion[],
  suffix = "success"
): VerifyHttpEvidenceInput {
  const runID = makeDomainID("run", "issue_runs", `666:http:${suffix}`);
  return {
    context: {
      attempt_id: makeRunAttemptID(runID, 1),
      audit_event_ref: `issue_events:666:http:${suffix}`,
      collected_at: COLLECTED_AT,
      evidence_id: makeDomainID("evidence", "issue_events", `666:http:${suffix}`),
      producer: { id: "runner-http-verifier", kind: "runner" },
      run_id: runID,
      source_ref: "http-fixture:666",
      work_id: makeDomainID("work", "issues", 666)
    },
    invocation: createHttpEvidenceInvocation(`http-verification-${suffix}`, { assertions, request })
  };
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "http-evidence-"));
  tempDirs.push(path);
  return path;
}

function startFixtureServer(): {
  observed: { apiKey: string; authorization: string; flakyRequests: number; totalRequests: number };
  server: ReturnType<typeof Bun.serve>;
} {
  const observed = { apiKey: "", authorization: "", flakyRequests: 0, totalRequests: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      observed.totalRequests += 1;
      observed.authorization = request.headers.get("authorization") ?? "";
      observed.apiKey = request.headers.get("x-api-key") ?? "";
      const path = new URL(request.url).pathname;
      if (path === "/healthy") {
        return Response.json({
          api_key: "body-secret",
          ready: true,
          service: { name: "fixture" },
          status: "ok"
        }, {
          headers: {
            "set-cookie": "session=response-cookie-secret; HttpOnly",
            "x-service-version": "2026.07",
            "x-trace-token": "response-secret"
          }
        });
      }
      if (path === "/unhealthy") return Response.json({ ready: "yes" }, { status: 503 });
      if (path === "/flaky") {
        observed.flakyRequests += 1;
        return Response.json({ ready: observed.flakyRequests >= 3 }, { status: observed.flakyRequests >= 3 ? 200 : 503 });
      }
      if (path === "/slow") {
        await Bun.sleep(60);
        return Response.json({ ready: true });
      }
      if (path === "/large-json") return Response.json({ payload: "x".repeat(2048), ready: true });
      return new Response("not found", { status: 404 });
    }
  });
  servers.push(server);
  return { observed, server };
}

function fixtureUrl(server: ReturnType<typeof Bun.serve>, path: string): string {
  return new URL(path, server.url).toString();
}
