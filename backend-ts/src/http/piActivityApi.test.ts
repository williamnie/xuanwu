import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createPiAction, createPiActionEvent } from "../db/repositories/pi.ts";
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

describe("PI Activity timeline API", () => {
  test("links fake CLI raw/context/intake/inbox/proposal to issue and reply with redacted summaries", async () => {
    const db = await openFixtureDatabase();
    try {
      seedProject(db, "demo");
      const seed = seedFakeCliFlow(db);
      createIssue(db, {
        description: "Unrelated external ref should not leak into source-scoped activity.",
        project_id: "demo",
        source_excerpt: "external_event:999",
        status: "triage",
        title: "Unrelated external ref"
      });
      const router = createDefaultRouter({ database: db });
      const domainRun = await jsonRequest(router, `/api/pi/attention-inbox/items/${seed.itemID}/domain-skill`, { method: "POST" });
      const proposal = await createCustomProposal(router, seed, domainRun.action.id);

      await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });

      const sourceTimeline = await jsonRequest(router, "/api/pi/activity?source=fixture-cli&limit=200");
      const proposalTimeline = await jsonRequest(router, `/api/pi/activity?proposal_id=${proposal.id}&limit=200`);
      const text = JSON.stringify(sourceTimeline);
      const stages = sourceTimeline.items.map((item: { stage: string }) => item.stage);

      expect(stages).toEqual(expect.arrayContaining(["Raw", "Context", "Intake", "Inbox", "Domain Skill", "Proposal", "Policy", "Action", "Issue", "Reply"]));
      expect(indexOf(stages, "Raw")).toBeLessThan(indexOf(stages, "Context"));
      expect(indexOf(stages, "Context")).toBeLessThan(indexOf(stages, "Intake"));
      expect(indexOf(stages, "Intake")).toBeLessThan(indexOf(stages, "Inbox"));
      expect(sourceTimeline.items.find((item: { kind: string }) => item.kind === "raw_event").links.detail)
        .toBe(`/api/pi/attention-inbox/raw-events/${seed.eventID}`);
      expect(sourceTimeline.items.some((item: { title: string }) => item.title.includes("Unrelated external ref"))).toBe(false);
      expect(text).not.toContain("raw-secret");
      expect(text).not.toContain("schema-secret");
      expect(text).not.toContain("/Users/secret");
      expect(proposalTimeline.items.map((item: { stage: string }) => item.stage))
        .toEqual(expect.arrayContaining(["Raw", "Context", "Intake", "Inbox", "Proposal", "Issue", "Reply"]));
    } finally {
      db.close();
    }
  });

  test("filters activity timeline by PI conversation id", async () => {
    const db = await openFixtureDatabase();
    try {
      seedProject(db, "demo");
      seedConversationActivity(db, "conv-a", "action-a");
      seedConversationActivity(db, "conv-b", "action-b");
      createPiActionEvent(db, {
        action_id: "tool-registry:conv-a",
        conversation_id: "conv-a",
        event_type: "runtime_tool_registry_snapshot",
        reason: "loaded PI runtime tools from registry"
      });
      const router = createDefaultRouter({ database: db });

      const timeline = await jsonRequest(router, "/api/pi/activity?conversation_id=conv-a&limit=200");
      const ids = timeline.items.map((item: { id: string }) => item.id);
      const text = JSON.stringify(timeline);

      expect(timeline.filters.conversation_id).toBe("conv-a");
      expect(ids).toContain("pi_action:action-a");
      expect(text).toContain("tool-registry:conv-a");
      expect(ids).not.toContain("pi_action:action-b");
      expect(text).not.toContain("conv-b");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-activity-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}


function seedConversationActivity(db: RunnerDatabase, conversationID: string, actionID: string): void {
  createPiAction(db, {
    action_type: "issue.status_summary",
    conversation_id: conversationID,
    id: actionID,
    payload_json: { conversation_id: conversationID },
    project_id: "demo",
    status: "completed"
  });
  createPiActionEvent(db, {
    action_id: actionID,
    conversation_id: conversationID,
    event_type: "tool_call_audit",
    project_id: "demo",
    reason: `audit for ${conversationID}`
  });
}

function seedFakeCliFlow(db: RunnerDatabase): { eventID: number; itemID: number } {
  const event = createExternalEvent(db, {
    actor: "cli-user",
    content: "AUTH_TOKEN=raw-secret CLI reports login 500",
    external_id: "cli-1",
    normalized_message: { message_id: "cli-msg-1" },
    occurred_at: "2026-07-06T03:01:00Z",
    provider: "fixture-cli-provider",
    raw_json: { token: "raw-secret", cwd: "/Users/secret/project" },
    received_at: "2026-07-06T03:01:01Z",
    source: "fixture-cli"
  });
  const bundle = createContextBundle(db, bundleInput(event.id), new Date("2026-07-06T03:02:00Z"));
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    schema_output: { items: [{ secret: "schema-secret", path: "/Users/secret/schema.json", title: "CLI login 500" }] },
    skill_id: "fixture-intake",
    status: "succeeded"
  }, new Date("2026-07-06T03:03:00Z"));
  const item = createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.93,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: run.id,
    primary_intent: "bug_report",
    secondary_intents: ["reply_needed"],
    source: "fixture-cli",
    suggested_actions: ["issue.create", "message.reply_draft"],
    summary: "CLI source reported a login 500 and expects a reply.",
    target_hints: [{ confidence: 0.95, id: "demo", kind: "project" }],
    title: "CLI login 500"
  }, new Date("2026-07-06T03:04:00Z"));
  return { eventID: event.id, itemID: item.id };
}

function bundleInput(eventID: number) {
  return {
    context: [{
      actor: "cli-user",
      attachment_refs: [],
      event_ref: eventID,
      occurred_at: "2026-07-06T03:01:00Z",
      source_ref: "fixture-cli:cli-1",
      summary: "CLI reports login 500"
    }],
    created_by: "automation" as const,
    event_refs: [eventID],
    reason: "fake_cli_activity_flow",
    source: "fixture-cli",
    trigger: "continuous" as const,
    window: { from: "2026-07-06T03:01:00Z", to: "2026-07-06T03:01:00Z" }
  };
}

async function createCustomProposal(
  router: ReturnType<typeof createDefaultRouter>,
  seed: { eventID: number; itemID: number },
  skillRunID: string
) {
  return await jsonRequest(router, "/api/pi/action-proposals", {
    body: JSON.stringify({
      actions: [
        action("issue.create", {
          body: "Create a traceable issue from fake CLI activity.",
          project_id: "demo",
          title: "CLI login 500"
        }, "medium", true),
        action("message.reply_draft", {
          draft: "收到，已创建追踪 issue，稍后同步处理结果。",
          evidence_refs: [`external_event:${seed.eventID}`],
          source: "fixture-cli"
        }, "low", false)
      ],
      confidence: 0.93,
      evidence_refs: [`external_event:${seed.eventID}`],
      id: "fake-cli-activity-proposal",
      skill_run_id: skillRunID,
      source_item_ids: [`attention_inbox_item:${seed.itemID}`],
      summary: "Create an issue and draft a reply for fake CLI.",
      target_hints: [{ confidence: 0.95, id: "demo", kind: "project" }]
    }),
    method: "POST"
  });
}

function action(type: string, payload: Record<string, unknown>, risk: string, requiresApproval: boolean) {
  return { payload, requires_approval: requiresApproval, risk, type };
}

function seedProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, approval_policy, sandbox, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, "/tmp/demo", "codex", "never", "danger-full-access", "2026-07-06T03:00:00Z", "2026-07-06T03:00:00Z"]
  );
}

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, init));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}

function indexOf(values: string[], value: string): number {
  const index = values.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
