import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { routeAgenticRequest } from "./server.ts";

let root = "";

afterEach(async () => {
  if (root !== "") await rm(root, { force: true, recursive: true });
  root = "";
});

describe("Agentic Worker narrow RPC server", () => {
  test("exposes only health and bounded internal RPC routes", async () => {
    const db = await fixture();
    try {
      const health = await routeAgenticRequest(db, new Request("http://127.0.0.1/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, role: "agentic" });
      expect(Number(health.headers.get("x-codex-runner-agentic-pid"))).toBe(process.pid);
      expect(Number(health.headers.get("x-codex-runner-agentic-rss-bytes"))).toBeGreaterThan(0);
      expect(health.headers.get("x-codex-runner-agentic-started-at")).toBeTruthy();

      const missing = await routeAgenticRequest(db, new Request("http://127.0.0.1/api/projects"));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "not found", ok: false });

      await expect(routeAgenticRequest(db, new Request(
        "http://127.0.0.1/api/internal/agentic/issue-acceptance",
        { body: JSON.stringify({ card: { issue: { id: 818, project_id: "demo" } } }), method: "POST" }
      ))).rejects.toThrow("completion card");
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  root = await mkdtemp(join(tmpdir(), "codex-runner-agentic-server-"));
  return openDatabase({ stateDir: join(root, "state") });
}
