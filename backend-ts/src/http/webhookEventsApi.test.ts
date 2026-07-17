import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const RUNNER_TOKEN = "runner-bearer-secret";
const SIGNING_SECRET = "webhook-signing-secret";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("signed Work webhook adapter", () => {
  test("normalizes a signed work.create, writes the existing external-event/link audit chain, and replays safely", async () => {
    const database = await fixtureDatabase();
    try {
      seedProject(database, "demo");
      const handle = createRequestHandler(createDefaultRouter({ database, webhookSigningSecret: SIGNING_SECRET }), RUNNER_TOKEN);
      const body = JSON.stringify({
        callback_token: "payload-secret",
        data: { goal: "Ship callback adapter", project_id: "demo", status: "todo", title: "Webhook Work" },
        id: "vendor-event-719",
        occurred_at: "2026-07-18T00:00:00.000Z",
        type: "work.create"
      });
      const first = await handle(signedRequest(body, "webhook-719"));
      const replay = await handle(signedRequest(body, "webhook-719"));
      const firstBody = await first.json() as Record<string, unknown>;
      const replayBody = await replay.json() as Record<string, unknown>;
      const text = JSON.stringify({ firstBody, replayBody });

      expect(first.status).toBe(202);
      expect(replay.status).toBe(200);
      expect(firstBody).toMatchObject({
        accepted: true,
        callback: { mode: "poll", status_url: expect.stringMatching(/^\/api\/works\//) },
        event: { idempotency_key: "webhook-719", source: "webhook" },
        replayed: false,
        work: { status: "todo", title: "Webhook Work" }
      });
      expect(replayBody).toMatchObject({ replayed: true, work: { id: (firstBody.work as Record<string, unknown>).id } });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 1 });
      const storedRaw = database.sqlite.query<Record<string, unknown>, []>("select raw_json from external_events").get();
      expect(String(storedRaw?.raw_json)).not.toContain("payload-secret");
      expect(text).not.toContain(SIGNING_SECRET);
      expect(text).not.toContain(RUNNER_TOKEN);
    } finally {
      database.close();
    }
  });

  test("rejects missing/invalid signatures, stale requests and conflicting replays with stable public codes", async () => {
    const database = await fixtureDatabase();
    try {
      seedProject(database, "demo");
      const handle = createRequestHandler(createDefaultRouter({ database, webhookSigningSecret: SIGNING_SECRET }), RUNNER_TOKEN);
      const body = JSON.stringify({ data: { goal: "g", project_id: "demo", title: "t" }, id: "event", type: "work.create" });
      const invalid = await handle(new Request(`${BASE_URL}/api/integrations/webhook/events`, {
        body,
        headers: {
          "content-type": "application/json",
          "idempotency-key": "bad-signature",
          "x-xuanwu-signature": "v1=not-a-valid-signature",
          "x-xuanwu-timestamp": new Date().toISOString()
        },
        method: "POST"
      }));
      const stale = await handle(signedRequest(body, "stale", "2020-01-01T00:00:00.000Z"));
      const accepted = await handle(signedRequest(body, "same-key"));
      const conflict = await handle(signedRequest(JSON.stringify({
        data: { goal: "changed", project_id: "demo", title: "t" }, id: "event", type: "work.create"
      }), "same-key"));

      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toEqual({ code: "invalid_signature", message: "webhook signature is invalid" });
      expect(stale.status).toBe(401);
      expect(await stale.json()).toEqual({ code: "invalid_signature_timestamp", message: "webhook timestamp is invalid or expired" });
      expect(accepted.status).toBe(202);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        code: "webhook_idempotency_conflict", message: "Idempotency-Key conflicts with a different event"
      });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-webhook-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.sqlite") });
}

function seedProject(database: RunnerDatabase, id: string): void {
  database.sqlite.run("insert into projects (id, name, cwd, auto_run, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [
    id, id, `/tmp/${id}-${crypto.randomUUID()}`, 0, "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"
  ]);
}

function signedRequest(body: string, key: string, timestamp = new Date().toISOString()): Request {
  const signature = createHmac("sha256", SIGNING_SECRET).update(`${timestamp}.${body}`).digest("hex");
  return new Request(`${BASE_URL}/api/integrations/webhook/events`, {
    body,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-xuanwu-signature": `v1=${signature}`,
      "x-xuanwu-timestamp": timestamp
    },
    method: "POST"
  });
}
