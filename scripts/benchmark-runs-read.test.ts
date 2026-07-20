import { afterAll, describe, expect, test } from "bun:test";
import { benchmarkRunsRead } from "./benchmark-runs-read.mjs";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/api/runs") {
      return Response.json(url.pathname === "/" ? { shell: true } : { items: [], total: 0 });
    }
    return new Response("not found", { status: 404 });
  }
});

afterAll(() => server.stop(true));

describe("Runs read benchmark", () => {
  test("reports warm and concurrent read-only samples without response bodies", async () => {
    const report = await benchmarkRunsRead({
      baseUrl: `http://127.0.0.1:${server.port}`,
      concurrentIterations: 2,
      hardLimitMs: 5_000,
      p95TargetMs: 5_000,
      warmIterations: 3,
      warmupIterations: 1
    });

    expect(report).toMatchObject({
      benchmark: "runs-read-v1",
      configuration: { concurrent_iterations: 2, warm_iterations: 3 },
      gate: { passed: true },
      method: "read_only_http_get",
      privacy: "response_bodies_and_auth_token_not_recorded"
    });
    expect(report.warm.samples_ms).toHaveLength(3);
    expect(report.concurrent.runs.samples_ms).toHaveLength(2);
    expect(report.concurrent.static.samples_ms).toHaveLength(2);
  });
});
