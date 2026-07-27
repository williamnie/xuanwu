import { describe, expect, test } from "bun:test";
import { createHttpAgenticWorkerClient } from "./client.ts";

describe("Agentic Worker HTTP client", () => {
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
      expect(calls.map((call) => call.url)).toEqual([
        "http://127.0.0.1:3010/health",
        "http://127.0.0.1:3010/api/internal/agentic/project-cycle"
      ]);
      expect(calls[1]?.headers.get("authorization")).toBe("Bearer rpc-secret");
      expect(calls[1]?.body).toEqual({ maxActions: 3, projectId: "demo" });
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
