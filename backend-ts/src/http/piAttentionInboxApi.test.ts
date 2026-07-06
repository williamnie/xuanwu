import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle, type ContextBundleRecord } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI Attention Inbox API", () => {
  test("lists compact evidence and exposes traceable details", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = seedInboxFixture(db);
      const router = createDefaultRouter({ database: db });

      const items = await jsonRequest(router, "/api/pi/attention-inbox/items?status=new");
      expect(items).toEqual([expect.objectContaining({
        id: fixture.itemID,
        primary_intent: "bug_report",
        project_hints: [expect.objectContaining({ id: "demo-project" })],
        status: "new"
      })]);
      expect(JSON.stringify(items)).not.toContain("schema_item_json");

      const item = await jsonRequest(router, `/api/pi/attention-inbox/items/${fixture.itemID}`);
      expect(item.links).toMatchObject({
        context_bundle: `/api/pi/attention-inbox/context-bundles/${fixture.bundle.id}`,
        intake_run: `/api/pi/attention-inbox/intake-runs/${fixture.runID}`,
        raw_events: [`/api/pi/attention-inbox/raw-events/${fixture.eventID}`]
      });

      const rawListText = await textRequest(router, "/api/pi/attention-inbox/raw-events?limit=5");
      expect(rawListText).toContain("attachment_count");
      expect(rawListText).not.toContain("raw_json");
      expect(rawListText).not.toContain("very-large-diagnostic-payload");

      const rawDetail = await jsonRequest(router, `/api/pi/attention-inbox/raw-events/${fixture.eventID}`);
      expect(rawDetail.raw_json.detail).toBe("very-large-diagnostic-payload");

      const bundles = await jsonRequest(router, "/api/pi/attention-inbox/context-bundles");
      expect(bundles[0]).toMatchObject({ id: fixture.bundle.id, event_refs: [fixture.eventID] });
      const runs = await jsonRequest(router, "/api/pi/attention-inbox/intake-runs?status=succeeded");
      expect(runs[0]).toMatchObject({ id: fixture.runID, status: "succeeded" });
    } finally {
      db.close();
    }
  });

  test("supports ignore, status update, re-intake request and domain skill proposal", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = seedInboxFixture(db);
      const router = createDefaultRouter({ database: db });

      const ignored = await jsonRequest(router, `/api/pi/attention-inbox/items/${fixture.itemID}/ignore`, { method: "POST" });
      expect(ignored.status).toBe("ignored");

      const triaged = await jsonRequest(router, `/api/pi/attention-inbox/items/${fixture.itemID}`, {
        body: JSON.stringify({ status: "triaged" }),
        method: "PATCH"
      });
      expect(triaged.status).toBe("triaged");

      const retry = await jsonRequest(router, `/api/pi/attention-inbox/items/${fixture.itemID}/reintake`, { method: "POST" });
      expect(retry).toMatchObject({ created: true, item_id: fixture.itemID });
      expect(retry.run).toMatchObject({ bundle_id: fixture.bundle.id, status: "running" });

      const proposal = await jsonRequest(router, `/api/pi/attention-inbox/items/${fixture.itemID}/domain-skill`, { method: "POST" });
      expect(proposal.item.status).toBe("proposal_created");
      expect(proposal.action).toMatchObject({ action_type: "attention_inbox.domain_skill", status: "proposal" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-attention-inbox-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedInboxFixture(db: RunnerDatabase) {
  const event = createExternalEvent(db, {
    actor: "alice",
    attachments: [{ kind: "image", name: "error.png", vision_summary: "login error screenshot" }],
    content: "登录页 500 了，截图里有报错",
    external_id: "m1",
    occurred_at: "2026-07-06T02:01:00Z",
    provider: "fixture-provider",
    raw_json: { detail: "very-large-diagnostic-payload" },
    received_at: "2026-07-06T02:01:01Z",
    source: "fixture-im"
  });
  const bundle = createContextBundle(db, bundleInput(event.id), new Date("2026-07-06T02:02:00Z"));
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    schema_output: { items: [{ title: "登录页 500" }], ignored: [] },
    skill_id: "pi.llm_intake.v1",
    status: "succeeded"
  }, new Date("2026-07-06T02:03:00Z"));
  const item = createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.91,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: run.id,
    primary_intent: "bug_report",
    schema_item: { detail: "schema detail kept for item detail only" },
    secondary_intents: ["reply_needed"],
    source: "fixture-im",
    suggested_actions: ["triage_attention_item", "create_issue_proposal"],
    summary: "用户反馈登录页 500，需要关注。",
    target_hints: [{ confidence: 0.8, id: "demo-project", kind: "project", reason: "chat context" }],
    title: "登录页 500"
  }, new Date("2026-07-06T02:04:00Z"));
  return { bundle, eventID: event.id, itemID: item.id, runID: run.id };
}

function bundleInput(eventID: number) {
  return {
    context: [{
      actor: "alice",
      attachment_refs: [`external_event:${eventID}#attachment:0`],
      event_ref: eventID,
      occurred_at: "2026-07-06T02:01:00Z",
      source_ref: "fixture-im:m1",
      summary: "登录页 500 了，截图里有报错"
    }],
    created_by: "automation" as const,
    event_refs: [eventID],
    reason: "fixture_attention_inbox",
    source: "fixture-im",
    token_budget: 1200,
    trigger: "continuous" as const,
    window: { from: "2026-07-06T02:01:00Z", to: "2026-07-06T02:01:00Z" }
  };
}

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, init));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}

async function textRequest(router: ReturnType<typeof createDefaultRouter>, path: string) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return response.text();
}
