import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { LEGACY_COMPATIBILITY_CONTRACT, LEGACY_COMPATIBILITY_REMOVAL_VERSION } from "./legacyCompatibilityApi.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? "", { force: true, recursive: true });
});

describe("legacy Issues/Sessions compatibility", () => {
  test("adds versioned deprecation headers without write-on-read telemetry", async () => {
    const database = await fixtureDatabase();
    try {
      const handle = createRequestHandler(createDefaultRouter({ database }), "", { database });
      const response = await handle(new Request("http://localhost/api/issues", {
        headers: { "x-codex-client": "contract-test" },
      }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(response.headers.get("deprecation")).toBe("true");
      expect(response.headers.get("sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      expect(response.headers.get("x-codex-compat-version")).toBe(LEGACY_COMPATIBILITY_CONTRACT);
      expect(response.headers.get("x-codex-canonical-resource")).toBe("/api/works");
      expect(response.headers.get("link")).toBe("</api/compatibility/legacy>; rel=\"deprecation\"; type=\"application/json\"");

      const report = await handle(new Request("http://localhost/api/compatibility/legacy"));
      expect(report.status).toBe(200);
      expect(await report.json()).toMatchObject({
        contract: LEGACY_COMPATIBILITY_CONTRACT,
        removal: { earliest_version: LEGACY_COMPATIBILITY_REMOVAL_VERSION },
        usage: [],
      });
    } finally {
      database.close();
    }
  });

  test("records frontend legacy redirects and leaves canonical APIs unmarked", async () => {
    const database = await fixtureDatabase();
    try {
      const handle = createRequestHandler(createDefaultRouter({ database }), "", { database });
      const recorded = await handle(new Request("http://localhost/api/compatibility/legacy/usage", {
        body: JSON.stringify({ family: "sessions", target: "runs" }),
        headers: { "content-type": "application/json", "x-codex-client": "xuanwu-web" },
        method: "POST",
      }));
      const works = await handle(new Request("http://localhost/api/works"));

      expect(recorded.status).toBe(202);
      expect(await recorded.json()).toEqual({ recorded: true });
      expect(works.headers.get("deprecation")).toBeNull();

      const report = await handle(new Request("http://localhost/api/compatibility/legacy"));
      expect(await report.json()).toMatchObject({
        usage: [{
          client: "xuanwu-web",
          family: "sessions",
          method: "NAVIGATE",
          path: "sessions",
          surface: "frontend_route",
        }],
      });
    } finally {
      database.close();
    }
  });

  test("rejects unknown legacy route families without writing telemetry", async () => {
    const database = await fixtureDatabase();
    try {
      const handle = createRequestHandler(createDefaultRouter({ database }), "", { database });
      const response = await handle(new Request("http://localhost/api/compatibility/legacy/usage", {
        body: JSON.stringify({ family: "cron", target: "automations" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }));
      expect(response.status).toBe(400);

      const report = await handle(new Request("http://localhost/api/compatibility/legacy"));
      expect(await report.json()).toMatchObject({ usage: [] });
    } finally {
      database.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-legacy-compat-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
}
