import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listExternalEvents, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { listAttentionInboxItems, type AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import { listImReplyDrafts } from "../db/repositories/imReplyOutbox.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { getActionProposal, listActionProposals } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "../http/server.ts";
import { routeInboxItemToDomainSkill, routeRawEventToIntake } from "./eventRouter.ts";
import { syncCliRawEvents } from "./cliRawEventSync.ts";
import type { LlmIntakeModel, LlmIntakeRequest } from "./llmIntake.ts";
const BASE_URL = "http://127.0.0.1:3008";
const SOURCE = "fixture-cli";
const PROVIDER = "fixture-cli-e2e";
const PROJECT_ID = "demo";
const tempRoots: string[] = [];
afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});
describe("fixture CLI to issue/reply proposal E2E", () => {
  test("syncs fake CLI events through intake, proposals, approval, activity, and dedupes reruns", async () => {
    const fixture = await openFixture();
    try {
      seedProject(fixture.db, PROJECT_ID);
      const router = createDefaultRouter({
        config: buildConfig({ cliConnectorDirs: [fixture.cliDir] }),
        database: fixture.db
      });
      const first = await runFixtureFlow(fixture.db, router);
      const counts = rowCounts(fixture.db);
      const bug = itemByIntent(first.items, "bug_report");
      const status = itemByIntent(first.items, "status_question");
      const issue = listIssues(fixture.db, { projectId: PROJECT_ID })[0];
      const draft = listImReplyDrafts(fixture.db, { source: SOURCE })[0];
      const bugProposal = proposalForItem(fixture.db, bug.id);
      const statusProposal = proposalForItem(fixture.db, status.id);
      const activity = await jsonRequest(router, `/api/pi/activity?source=${SOURCE}&limit=200`);
      const stages = activity.items.map((item: { stage: string }) => item.stage);
      expect(first.route).toMatchObject({ status: "routed" });
      expect(first.sync.processed_watermark).toBe("fixture-watermark-2");
      expect(bug.evidence_refs.some((ref) => ref.includes("#attachment:0"))).toBe(true);
      expect(issue).toMatchObject({
        source_turn_id: `attention_inbox_item:${bug.id}`,
        status: "triage",
        title: "登录页 500"
      });
      expect(`${issue.description}\n${issue.source_excerpt}`).toContain("#attachment:0");
      expect(issue.source_excerpt).toContain(`proposal:${bugProposal.id}`);
      expect(bugProposal).toMatchObject({
        evidence_refs: bug.evidence_refs,
        source_item_ids: [`attention_inbox_item:${bug.id}`],
        status: "approved"
      });
      expect(draft).toMatchObject({
        external_event_id: eventByExternalID(first.events, "status-1").id,
        source: SOURCE,
        status: "pending",
        target_chat_id: "cli-chat",
        target_message_id: "status-1"
      });
      expect(statusProposal).toMatchObject({
        evidence_refs: status.evidence_refs,
        source_item_ids: [`attention_inbox_item:${status.id}`],
        status: "approved"
      });
      expect(statusProposal.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          evidence_refs: status.evidence_refs,
          pi_action_id: draft.approval_action_id,
          type: "message.reply_draft"
        })
      ]));
      expect(stages).toEqual(expect.arrayContaining([
        "Raw", "Context", "Intake", "Inbox", "Domain Skill", "Proposal", "Policy", "Action", "Issue", "Reply"
      ]));
      const second = await runFixtureFlow(fixture.db, router);
      expect(second.route).toMatchObject({ reason: "duplicate_raw_event", status: "skipped" });
      expect(rowCounts(fixture.db)).toEqual(counts);
    } finally {
      fixture.db.close();
    }
  });
});
async function runFixtureFlow(
  db: RunnerDatabase,
  router: ReturnType<typeof createDefaultRouter>
) {
  const output = await pullCliEvents(router);
  const sync = syncCliRawEvents(db, output, { defaultProvider: PROVIDER, defaultSource: SOURCE });
  const events = listExternalEvents(db, { limit: 20, source: SOURCE });
  const anchor = eventByExternalID(events, "status-1");
  const route = await routeRawEventToIntake(db, anchor, events, fixtureIntakeModel(), {
    policy: { profile: "ops_chat" },
    skillId: "fixture-cli-intake"
  });
  const items = listAttentionInboxItems(db, { limit: 20, source: SOURCE });
  for (const item of items) await routeInboxItemToDomainSkill(db, item, domainRouteOptions());
  for (const proposal of listActionProposals(db)) await approveProposal(router, proposal.id);
  return { events, items, route, sync };
}
async function pullCliEvents(router: ReturnType<typeof createDefaultRouter>): Promise<unknown> {
  const body = await jsonRequest(router, `/api/pi/tools/${encodeURIComponent(`${PROVIDER}:pull-events`)}/call`, {
    body: JSON.stringify({ input: { cursor: "" }, permission: "read" }),
    method: "POST"
  });
  expect(body.result).toMatchObject({ status: "succeeded" });
  return body.result.output;
}
function fixtureIntakeModel(): LlmIntakeModel {
  return (request) => ({
    ignored_groups: [],
    inbox_items: [bugReportItem(request), statusQuestionItem(request)]
  });
}
function bugReportItem(request: LlmIntakeRequest) {
  const event = eventSummary(request, "bug-1");
  return {
    actor_refs: [event.actor],
    confidence: 0.94,
    evidence_refs: eventRefs(event),
    intents: { primary: "bug_report", secondary: ["reply_needed"], tags: ["fixture_cli", "screenshot"] },
    suggested_actions: ["issue.create"],
    summary: `${event.summary}；截图 metadata 作为多模态 evidence 进入提案。`,
    target_hints: [projectHint()],
    title: "登录页 500",
    urgency: "medium"
  };
}
function statusQuestionItem(request: LlmIntakeRequest) {
  const event = eventSummary(request, "status-1");
  return {
    actor_refs: [event.actor],
    confidence: 0.9,
    evidence_refs: eventRefs(event),
    intents: { primary: "status_question", secondary: ["reply_needed"], tags: ["fixture_cli"] },
    suggested_actions: ["issue.status_lookup", "message.reply_draft"],
    summary: "老板追问登录页 500 修复状态，需要先查状态再准备回复草稿。",
    target_hints: [projectHint()],
    title: "登录页 500 修复状态",
    urgency: "low"
  };
}
function eventSummary(request: LlmIntakeRequest, externalID: string) {
  const events = request.input.context_bundle.raw_event_summaries;
  const event = events.find((item) => item.source_ref === `${SOURCE}:${externalID}`);
  if (!event) throw new Error(`fixture event missing from intake input: ${externalID}`);
  return event;
}
function eventRefs(event: LlmIntakeRequest["input"]["context_bundle"]["raw_event_summaries"][number]): string[] {
  return [event.evidence_ref, ...event.attachments.map((attachment) => attachment.evidence_ref)];
}
function domainRouteOptions() {
  return {
    policy: { profile: "ops_chat" as const },
    project: { project_confirmed: true, project_id: PROJECT_ID }
  };
}
async function approveProposal(router: ReturnType<typeof createDefaultRouter>, id: string): Promise<void> {
  const approved = await jsonRequest(router, `/api/pi/action-proposals/${encodeURIComponent(id)}/approve`, {
    body: JSON.stringify({ actor: "fixture-smoke" }),
    method: "POST"
  });
  expect(approved.status).toBe("approved");
}
function itemByIntent(items: AttentionInboxItemRecord[], intent: string): AttentionInboxItemRecord {
  const item = items.find((entry) => entry.primary_intent === intent);
  if (!item) throw new Error(`inbox item not found for intent: ${intent}`);
  return item;
}
function proposalForItem(db: RunnerDatabase, itemID: number) {
  const proposal = listActionProposals(db).find((item) => item.source_item_ids.includes(`attention_inbox_item:${itemID}`));
  if (!proposal) throw new Error(`proposal not found for inbox item: ${itemID}`);
  return getActionProposal(db, proposal.id) ?? proposal;
}
function eventByExternalID(events: ExternalEventRecord[], externalID: string): ExternalEventRecord {
  const event = events.find((item) => item.external_id === externalID);
  if (!event) throw new Error(`event not found: ${externalID}`);
  return event;
}
function rowCounts(db: RunnerDatabase) {
  return {
    drafts: listImReplyDrafts(db, { source: SOURCE }).length,
    issues: listIssues(db, { projectId: PROJECT_ID }).length,
    proposals: listActionProposals(db).length
  };
}
function projectHint() {
  return { confidence: 0.95, id: PROJECT_ID, kind: "project", reason: "fixture CLI project hint" };
}
async function openFixture(): Promise<{ cliDir: string; db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-fixture-cli-e2e-"));
  tempRoots.push(root);
  const cliDir = join(root, "connectors");
  await writeFixtureCli(cliDir);
  return { cliDir, db: await openDatabase({ stateDir: join(root, "state") }), root };
}
async function writeFixtureCli(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const script = join(dir, "fixture-cli.mjs");
  await writeFile(script, CLI_SCRIPT, "utf8");
  await writeFile(join(dir, "fixture-cli.json"), JSON.stringify(cliManifest(script), null, 2), "utf8");
}
function seedProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, approval_policy, sandbox, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", "never", "danger-full-access", "2026-07-06T03:00:00Z", "2026-07-06T03:00:00Z"]
  );
}
async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<Record<string, any>>;
}
function cliManifest(script: string): Record<string, unknown> {
  return {
    manifest_version: "pi-cli-connector.v0",
    id: PROVIDER,
    name: "Fixture CLI E2E",
    kind: "cli",
    timeout: { default_ms: 2000, max_ms: 5000 },
    health: {
      command: { executable: process.execPath, args: [script, "health"] },
      stdout: { mode: "json" },
      exit_codes: { success: [0] }
    },
    commands: [pullEventsCommand(script)]
  };
}
function pullEventsCommand(script: string): Record<string, unknown> {
  return {
    name: "pull-events",
    description: "Pull fixture chat events for PI Assistant E2E.",
    permission: "read",
    command: { executable: process.execPath, args: [script, "pull", "{{input.cursor}}"] },
    input_schema: { type: "object", properties: { cursor: { type: "string" } } },
    output_schema: { type: "object", properties: { events: { type: "array" }, processed_watermark: { type: "string" } } },
    stdout: { mode: "json" },
    exit_codes: { success: [0] },
    cursor: { input_field: "cursor", output_field: "processed_watermark" },
    idempotency: { input_field: "cursor" }
  };
}
const CLI_SCRIPT = `
const mode = process.argv[2];
if (mode === "health") {
  console.log(JSON.stringify({ ok: true }));
} else {
  console.log(JSON.stringify({
    source: "fixture-cli",
    provider: "fixture-cli-e2e",
    processed_watermark: "fixture-watermark-2",
    events: [
      {
        source_ref: "fixture-cli:bug-1",
        external_id: "bug-1",
        dedupe_key: "fixture-cli:bug-1",
        event_type: "message",
        occurred_at: "2026-07-06T03:01:00Z",
        received_at: "2026-07-06T03:01:01Z",
        actor: "alice",
        content: "登录页 500 了，截图里有报错",
        project_id: "demo",
        normalized_message: { chat_id: "cli-chat", message_id: "bug-1", thread_id: "thread-login" },
        attachments: [{ kind: "image", mime_type: "image/png", name: "login-500.png", remote_ref: "fixture://login-500.png", vision_summary: "screenshot shows HTTP 500 on login page" }]
      },
      {
        source_ref: "fixture-cli:status-1",
        external_id: "status-1",
        dedupe_key: "fixture-cli:status-1",
        event_type: "message",
        occurred_at: "2026-07-06T03:04:00Z",
        received_at: "2026-07-06T03:04:01Z",
        actor: "boss",
        content: "@PI 登录页 500 修好了吗？需要回复老板。",
        project_id: "demo",
        normalized_message: { bot_mentioned: true, chat_id: "cli-chat", message_id: "status-1", thread_id: "thread-login" }
      }
    ]
  }));
}
`;
