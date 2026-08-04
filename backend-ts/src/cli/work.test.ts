import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, createRequestHandler } from "../http/server.ts";
import { runCli } from "./command.ts";
import type { Fetcher } from "./types.ts";

const BASE_URL = "http://127.0.0.1:3008";
const TOKEN = "cli-work-token";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Work CLI", () => {
  test("creates an Issue-backed Work idempotently, then queries its status and result through HTTP", async () => {
    const database = await fixtureDatabase();
    try {
      seedProject(database, "demo");
      const handle = createRequestHandler(createDefaultRouter({ database }), TOKEN);
      const fetcher = (async (input: Parameters<Fetcher>[0], init?: Parameters<Fetcher>[1]) => {
        return await handle(new Request(input instanceof Request ? input.url : String(input), init));
      }) as unknown as Fetcher;
      const env = (key: string) => key === "XUANWU_AUTH_TOKEN" ? TOKEN : undefined;

      const created = await invoke([
        "work", "create", "--project", "demo", "--title", "CLI Work", "--goal", "Create through the CLI",
        "--idempotency-key", "ci-719-create", "--occurred-at", "2026-07-18T00:00:00.000Z", "--json"
      ], env, fetcher);
      const replay = await invoke([
        "work", "create", "--project", "demo", "--title", "CLI Work", "--goal", "Create through the CLI",
        "--idempotency-key", "ci-719-create", "--occurred-at", "2026-07-18T00:00:00.000Z", "--json"
      ], env, fetcher);
      expect(created).toMatchObject({ code: 0, stderr: "" });
      expect(replay).toMatchObject({ code: 0, stderr: "" });
      const workID = String((JSON.parse(created.stdout).work as Record<string, unknown>).id);
      const status = await invoke(["work", "status", "--id", workID, "--json"], env, fetcher);
      const result = await invoke(["work", "result", "--id", workID, "--json"], env, fetcher);

      expect(JSON.parse(created.stdout)).toMatchObject({ work: { id: workID, status: "triage" } });
      expect(JSON.parse(replay.stdout)).toMatchObject({ work: { id: workID } });
      expect(status).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(status.stdout)).toMatchObject({ work: { id: workID, status: "triage" } });
      expect(JSON.parse(result.stdout)).toEqual({ work: expect.objectContaining({ id: workID, status: "triage" }) });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
      expect(`${created.stdout}${replay.stdout}${status.stdout}${result.stdout}`).not.toContain(TOKEN);
    } finally {
      database.close();
    }
  });

  test("requires an explicit replay key and keeps auth failures redacted", async () => {
    const missingKey = await invoke([
      "work", "create", "--project", "demo", "--title", "x", "--goal", "x", "--occurred-at", "2026-07-18T00:00:00.000Z"
    ], () => undefined, fetch);
    const authFailure = await invoke(["work", "status", "--id", "xw:work:issues:1"], (key) => (
      key === "XUANWU_AUTH_TOKEN" ? TOKEN : undefined
    ), (async () => new Response(JSON.stringify({ message: `Bearer ${TOKEN}` }), { status: 401 })) as unknown as Fetcher);

    expect(missingKey).toMatchObject({ code: 1, stdout: "" });
    expect(missingKey.stderr).toContain("--idempotency-key is required");
    expect(authFailure).toMatchObject({ code: 1, stdout: "" });
    expect(authFailure.stderr).not.toContain(TOKEN);
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-cli-work-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.sqlite") });
}

function seedProject(database: RunnerDatabase, id: string): void {
  database.sqlite.run("insert into projects (id, name, cwd, auto_run, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [
    id, id, `/tmp/${id}-${crypto.randomUUID()}`, 0, "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"
  ]);
}

async function invoke(
  args: string[],
  env: (key: string) => string | undefined,
  fetcher: Fetcher
): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = new Writer();
  const stderr = new Writer();
  const code = await runCli(args, stdout, stderr, { env, fetch: fetcher });
  return { code, stderr: stderr.text, stdout: stdout.text };
}

class Writer {
  text = "";
  write(chunk: Uint8Array | string): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}
