#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";
import { createIssue } from "../backend-ts/src/db/repositories/issueCreate.ts";
import { getIssue } from "../backend-ts/src/db/repositories/issues.ts";
import { updateIssue } from "../backend-ts/src/db/repositories/issueUpdate.ts";
import { listSyncOutbox } from "../backend-ts/src/db/repositories/imReplyOutbox.ts";
import { createPiConversation, listPiIssueCompletionWatches } from "../backend-ts/src/db/repositories/pi.ts";
import { EventBus } from "../backend-ts/src/events/bus.ts";
import { normalizeFeishuMessageEvent } from "../backend-ts/src/integrations/feishu.ts";
import { applyFeishuCompletionWatchCommand } from "../backend-ts/src/integrations/feishuCompletionWatchCommand.ts";
import { routeFeishuConversation } from "../backend-ts/src/integrations/feishuConversationRouting.ts";
import { resolveFeishuProjectContextFromDatabase } from "../backend-ts/src/integrations/feishuProjectContext.ts";
import { attachFeishuNotificationObservers } from "../backend-ts/src/integrations/feishuNotifications.ts";
import { attachPiIssueCompletionWatchObserver } from "../backend-ts/src/pi/issueCompletionWatchEvaluator.ts";

const SMOKE_DATE = new Date("2026-06-29T10:00:00Z");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-completion-watch-smoke-"));
  try {
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const result = runSmoke(db, root);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runSmoke(db, root) {
  insertProject(db, root);
  const first = createIssue(db, { project_id: "demo", status: "todo", title: "Smoke done issue" });
  const second = createIssue(db, { project_id: "demo", status: "todo", title: "Smoke failed issue" });
  const event = fakeFeishuEvent(`等 #${first.id} #${second.id} 做完通知我`);
  const route = routeFeishuConversation(db, { clock: { now: () => SMOKE_DATE }, event, prompt: event.text });
  createPiConversation(db, { id: route.conversationId, pi_agent_id: "pi-smoke", project_id: "demo", title: "Completion watch smoke" });
  const watch = createWatchFromCommand(db, event, route, [first.id, second.id]);
  const bus = new EventBus();
  const detachWatch = attachPiIssueCompletionWatchObserver({ bus, database: db });
  const detachFeishu = attachFeishuNotificationObservers({ bus, database: db });
  try {
    publishStatus(db, bus, first.id, "done");
    assert(listSyncOutbox(db, { source: "feishu" }).length === 0, "outbox should stay empty before all watched issues finish");
    publishStatus(db, bus, second.id, "failed", "smoke simulated failure");
  } finally {
    detachFeishu();
    detachWatch();
  }
  const outbox = listSyncOutbox(db, { source: "feishu" });
  assert(outbox.length === 1, "completion watch must queue exactly one summary outbox item", { outboxCount: outbox.length });
  assert(outbox[0].content.includes(`#${first.id}`) && outbox[0].content.includes(`#${second.id}`), "summary must include both watched issues");
  assert(!outbox[0].content.includes("missing_feishu_link"), "summary must not fail through watched issue Feishu links");
  return {
    conversation_id: route.conversationId,
    fake_event_id: event.raw_event_ref,
    issue_statuses: [getIssue(db, first.id)?.status, getIssue(db, second.id)?.status],
    outbox: { id: outbox[0].id, status: outbox[0].status, target_chat_id: outbox[0].target_chat_id },
    watch_id: watch.id,
    watched_issue_ids: [first.id, second.id]
  };
}

function createWatchFromCommand(db, event, route, ids) {
  const projectContext = resolveFeishuProjectContextFromDatabase(db, {
    message: { chatId: event.chat_id, senderId: event.sender.id, senderOpenId: event.sender.open_id },
    scopeKey: route.scopeKey,
    text: event.text
  });
  const result = applyFeishuCompletionWatchCommand(db, {
    event,
    projectContext,
    route,
    sourceEventId: event.raw_event_ref,
    text: event.text
  });
  assert(result.handled && result.reason === "completion_watch_created", "command should create completion watch", result);
  const watch = listPiIssueCompletionWatches(db, { projectId: "demo", status: "active" })[0];
  assert(watch && ids.every((id) => watch.items.some((item) => item.issue_id === id)), "watch should contain both issues");
  return watch;
}

function fakeFeishuEvent(text) {
  return normalizeFeishuMessageEvent({
    event: {
      event_id: "evt_completion_watch_smoke",
      message: {
        chat_id: "oc_completion_watch_smoke",
        chat_type: "group",
        content: JSON.stringify({ text }),
        create_time: String(SMOKE_DATE.getTime()),
        message_id: "om_completion_watch_smoke"
      },
      sender: {
        sender_id: { open_id: "ou_completion_watch_open", user_id: "ou_completion_watch_user" },
        sender_type: "user",
        tenant_key: "tenant_smoke"
      }
    }
  }, { rawEventRef: "evt_completion_watch_smoke" });
}

function publishStatus(db, bus, issueID, status, error = "") {
  updateIssue(db, issueID, { error, status });
  const issue = getIssue(db, issueID);
  bus.publish({
    issueId: issueID,
    payload: JSON.stringify({ status }),
    projectId: issue?.project_id,
    type: "issue.status_changed"
  });
}

function insertProject(db, root) {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", "{}", 1, "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

main().catch((error) => {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
