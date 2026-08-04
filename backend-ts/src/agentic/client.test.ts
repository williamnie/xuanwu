import { describe, expect, test } from "bun:test";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import { createHttpAgenticWorkerClient } from "./client.ts";

describe("Agentic Worker HTTP client", () => {
  test("publishes in-flight and settled activity around Agentic RPC work", async () => {
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    let nowMs = Date.parse("2026-07-27T03:00:00.000Z");
    try {
      globalThis.fetch = (() => new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ ok: true, result: { accepted: true } }, {
          headers: {
            "x-xuanwu-agentic-pid": "3010",
            "x-xuanwu-agentic-rss-bytes": "188743680",
            "x-xuanwu-agentic-started-at": "2026-07-27T02:59:00.000Z"
          }
        }));
      })) as unknown as typeof fetch;
      const client = createHttpAgenticWorkerClient({
        addr: "127.0.0.1:3010",
        now: () => new Date(nowMs)
      });

      const request = client.runProjectCycle({ maxActions: 1, projectId: "demo" });
      expect(client.activity()).toEqual({
        in_flight: 1,
        last_activity_at: "2026-07-27T03:00:00.000Z"
      });

      nowMs += 45_000;
      release();
      await expect(request).resolves.toEqual({ accepted: true });
      expect(client.activity()).toEqual({
        in_flight: 0,
        last_activity_at: "2026-07-27T03:00:45.000Z",
        worker_pid: 3010,
        worker_rss_bytes: 188743680,
        worker_started_at: "2026-07-27T02:59:00.000Z"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends authenticated bounded RPC requests", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    try {
      globalThis.fetch = (async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          url: String(url)
        });
        return String(url).endsWith("/health")
          ? Response.json({ ok: true, role: "agentic" })
          : Response.json({ ok: true, result: { accepted: true } });
      }) as typeof fetch;
      const client = createHttpAgenticWorkerClient({
        addr: "127.0.0.1:3010",
        authToken: "rpc-secret"
      });

      await expect(client.health()).resolves.toEqual({ ok: true, role: "agentic" });
      await expect(client.runProjectCycle({ maxActions: 3, projectId: "demo" })).resolves.toEqual({ accepted: true });
      const card = { issue: { id: 818, project_id: "demo" } } as CompletionCard;
      await client.decideIssueAcceptance!(card);
      expect(calls.map((call) => call.url)).toEqual([
        "http://127.0.0.1:3010/health",
        "http://127.0.0.1:3010/api/internal/agentic/project-cycle",
        "http://127.0.0.1:3010/api/internal/agentic/issue-acceptance"
      ]);
      expect(calls[1]?.headers.get("authorization")).toBe("Bearer rpc-secret");
      expect(calls[1]?.body).toEqual({ maxActions: 3, projectId: "demo" });
      expect(calls[2]?.body).toEqual({ card });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails with a stable timeout error", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as typeof fetch;
      const client = createHttpAgenticWorkerClient({ addr: "127.0.0.1:3010", timeoutMs: 10 });

      await expect(client.runProjectCycle({ maxActions: 1, projectId: "demo" }))
        .rejects.toThrow("Agentic Worker request timed out after 10ms");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
