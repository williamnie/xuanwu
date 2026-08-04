import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, registerSystemLogsRoute } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun system logs API", () => {
  test("returns redacted runtime logs under Bun state dir", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      await writeRuntimeLogs(config.stateDir);
      const router = createDefaultRouter();
      registerSystemLogsRoute(router, { config });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/logs?lines=20`));
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as RuntimeLogsBody;

      expect(response.status).toBe(200);
      expect(body.logs).toHaveLength(2);
      expect(body.logs[0]).toMatchObject({ source: "server", available: true });
      expect(body.logs[1]).toMatchObject({ source: "runner", available: true });
      expect(body.logs[0]?.path).toBe("<stateDir>/logs/launchd.out.log");
      expect(body.logs[1]?.path).toBe("<stateDir>/logs/launchd.err.log");
      expect(body.recent_errors.length).toBeGreaterThan(0);
      expect(body.recent_warnings.length).toBeGreaterThan(0);
      expect(bodyText).not.toContain(config.stateDir);
      for (const forbidden of ["secret-token", "super-secret", "env-secret", "hidden-pass", "auth_token"]) {
        expect(bodyText).not.toContain(forbidden);
      }
      expect(bodyText).not.toContain("/Users/alice/private");
      expect(bodyText).toContain("token=[redacted]");
      expect(bodyText).toContain("SECRET_KEY=[redacted]");
      expect(bodyText).toContain("cwd=[redacted-path]");
    } finally {
      database.close();
    }
  });

  test("reports missing default log files without using legacy data dir", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      const router = createDefaultRouter();
      registerSystemLogsRoute(router, { config });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/logs`));
      const body = await response.json() as RuntimeLogsBody;

      expect(response.status).toBe(200);
      expect(body.logs).toHaveLength(2);
      for (const logFile of body.logs) {
        expect(logFile.available).toBe(false);
        expect(logFile.error).toContain("log file does not exist");
        expect(logFile.path).toStartWith("<stateDir>/logs/");
        expect(logFile.path).not.toContain(config.stateDir);
        expect(logFile.path).not.toContain(join("data", "logs"));
      }
    } finally {
      database.close();
    }
  });
});

async function openFixtureRuntime(): Promise<{
  config: ReturnType<typeof buildConfig>;
  database: RunnerDatabase;
}> {
  const root = await tempPath("xuanwu-bun-system-logs-");
  const stateDir = join(root, "state");
  const config = buildConfig({ stateDir });
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  return { config, database };
}

async function writeRuntimeLogs(stateDir: string): Promise<void> {
  const logDir = join(stateDir, "logs");
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, "launchd.out.log"), [
    "2026/05/28 01:02:03 API listening",
    "2026-05-28T01:03:04Z warn provider probe slow",
    "Authorization: Bearer secret-token",
    "Xuanwu generated auth token file: /tmp/auth_token",
    "2026-05-28T01:03:05Z warn cwd=/Users/alice/private/project",
    "2026-05-28T01:04:05Z error runner failed token=super-secret SECRET_KEY=env-secret"
  ].join("\n"));
  await writeFile(join(logDir, "launchd.err.log"), "panic: runner password=hidden-pass\n");
}

type RuntimeLogsBody = {
  logs: Array<{ available: boolean; error?: string; path: string; source: string }>;
  recent_errors: Array<Record<string, unknown>>;
  recent_warnings: Array<Record<string, unknown>>;
};
