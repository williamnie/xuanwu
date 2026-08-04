import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, createRequestHandler } from "../http/server.ts";
import {
  assertOpenClawGatewayAdapterConformance,
  buildOpenClawApprovalCallback,
  buildOpenClawHandoffResponse,
  buildOpenClawWorkCreate,
  signOpenClawWorkCreate,
  type OpenClawSessionInput
} from "./openclawGatewayAdapter.ts";

const FIXTURE_URL = new URL("../../../docs/fixtures/openclaw-gateway-v1.fixture.json", import.meta.url);
const SIGNING_SECRET = "openclaw-fixture-signing-secret";
const RUNNER_TOKEN = "openclaw-fixture-runner-token";
const BASE_URL = "http://127.0.0.1:3008";
const roots: string[] = [];

type Fixture = { session_a: OpenClawSessionInput; session_b: OpenClawSessionInput };

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("OpenClaw Gateway optional adapter", () => {
  test("sandbox fixture maps same-channel retries deterministically and keeps channel sessions isolated", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Fixture;
    assertOpenClawGatewayAdapterConformance();
    const a = buildOpenClawWorkCreate({
      ...fixture.session_a,
      event_id: "evt-722", goal: "Create isolated Work", occurred_at: "2026-07-18T00:00:00.000Z",
      project_id: "demo", status: "todo", title: "OpenClaw Work"
    });
    const retry = buildOpenClawWorkCreate({
      ...fixture.session_a,
      event_id: "evt-722", goal: "Create isolated Work", occurred_at: "2026-07-18T00:00:00.000Z",
      project_id: "demo", status: "todo", title: "OpenClaw Work"
    });
    const b = buildOpenClawWorkCreate({
      ...fixture.session_b,
      event_id: "evt-722", goal: "Create isolated Work", occurred_at: "2026-07-18T00:00:00.000Z",
      project_id: "demo", status: "todo", title: "OpenClaw Work"
    });

    expect(retry).toEqual(a);
    expect(b.idempotency_key).not.toBe(a.idempotency_key);
    expect(b.event_id).not.toBe(a.event_id);
    expect(b.mapping.identity_ref).not.toBe(a.mapping.identity_ref);
    expect(b.mapping.session_ref).not.toBe(a.mapping.session_ref);
    expect(a.body).toMatchObject({ data: { gateway: a.mapping }, type: "work.create" });
  });

  test("signs only the existing webhook contract and does not place its secret in the body", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Fixture;
    const signed = signOpenClawWorkCreate({
      ...fixture.session_a,
      event_id: "evt-sign", goal: "signed", occurred_at: "2026-07-18T00:00:00.000Z", project_id: "demo", title: "signed"
    }, SIGNING_SECRET, "2026-07-18T00:01:00.000Z");
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(`2026-07-18T00:01:00.000Z.${signed.raw_body}`).digest("hex");

    expect(signed.headers["x-xuanwu-signature"]).toBe(`v1=${expected}`);
    expect(signed.raw_body).not.toContain(SIGNING_SECRET);
  });

  test("sends the fixture through the existing signed webhook and retains only its existing audit chain", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Fixture;
    const database = await fixtureDatabase();
    try {
      seedProject(database, "demo");
      const signed = signOpenClawWorkCreate({
        ...fixture.session_a,
        event_id: "evt-end-to-end", goal: "Use existing Work authority", occurred_at: "2026-07-18T00:00:00.000Z",
        project_id: "demo", title: "OpenClaw end-to-end"
      }, SIGNING_SECRET);
      const handle = createRequestHandler(createDefaultRouter({ database, webhookSigningSecret: SIGNING_SECRET }), RUNNER_TOKEN);
      const response = await handle(new Request(`${BASE_URL}/api/integrations/webhook/events`, {
        body: signed.raw_body,
        headers: signed.headers,
        method: "POST"
      }));
      const payload = await response.json() as Record<string, unknown>;
      const raw = database.sqlite.query<{ raw_json: string }, []>("select raw_json from external_events").get();

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        event: { source: "webhook" },
        work: { status: "triage", title: "OpenClaw end-to-end" }
      });
      expect(JSON.parse(raw?.raw_json ?? "{}")).toMatchObject({ data: { gateway: signed.mapping } });
      expect(database.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 1 });
      expect(database.sqlite.query("select count(*) as count from external_links").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("approval callback fails closed across Runner sessions and Handoff response stays transport-only", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Fixture;
    const base = {
      ...fixture.session_a,
      approval: { id: "approval-722", session_id: "runner-session-a" },
      decision: "approve" as const,
      runner_session_id: "runner-session-a"
    };
    expect(() => buildOpenClawApprovalCallback({ ...base, runner_session_id: "runner-session-b" }))
      .toThrow("approval is not bound to the mapped Runner session");
    expect(buildOpenClawApprovalCallback(base)).toMatchObject({
      body: { decision: "approve", scope: "turn" },
      method: "POST",
      path: "/api/pi/approval-requests/approval-722/resolve"
    });

    const response = buildOpenClawHandoffResponse({
      ...fixture.session_a,
      handoff: { id: "xw:handoff:derived:722", status: "ready", summary: "verified" },
      runner_session_id: "runner-session-a"
    });
    expect(response).toMatchObject({
      handoff: { id: "xw:handoff:derived:722", status: "ready" },
      runner_session_id: "runner-session-a",
      type: "handoff.response"
    });
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-openclaw-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.sqlite") });
}

function seedProject(database: RunnerDatabase, id: string): void {
  database.sqlite.run("insert into projects (id, name, cwd, auto_run, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [
    id, id, `/tmp/${id}-${crypto.randomUUID()}`, 0, "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"
  ]);
}
