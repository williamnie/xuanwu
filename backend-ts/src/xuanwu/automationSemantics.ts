export type AutomationSemanticRole = "trigger" | "execution" | "observation" | "archive";
export type AutomationCarrierDisposition = "keep" | "merge" | "migrate" | "delete";

export type AutomationCarrier = {
  id: string;
  role: AutomationSemanticRole;
  tables: readonly string[];
  current_authority: string;
  target_semantics: string;
  disposition: AutomationCarrierDisposition;
  duplicate_with: readonly string[];
  rollback: string;
  final_delete_gate: string;
  source_files: readonly string[];
};

export type AutomationStatusMapping = {
  carrier: string;
  field: string;
  source_status: string;
  canonical_status: string;
  semantic_axis: "definition" | "execution" | "observation" | "archive";
};

export type AutomationRoute = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  role: "definition" | "trigger" | "control" | "observation";
  write: boolean;
};

export const AUTOMATION_CARRIERS = [
  {
    id: "cron",
    role: "trigger",
    tables: ["cron_tasks", "cron_task_schedules"],
    current_authority: "cron_tasks owns definition/lifecycle/claim/result; cron_task_schedules owns schedule policy until cutover",
    target_semantics: "Automation schedule trigger and compatibility command adapter",
    disposition: "migrate",
    duplicate_with: ["pi_automation_schedule", "delegation_heartbeat_schedule"],
    rollback: "Before G4 disable target shadow/read and continue cron_tasks; after G4 stop target writer and replay the audited cutover delta before restoring cron writes.",
    final_delete_gate: "P11.04/P11.09, no active task or claim, schedule/quiet-hours/missed-run/restart parity, one release with zero storage consumers, archive plus restore rehearsal, and non-LLM G7 approval.",
    source_files: [
      "backend-ts/src/runner/cronExecutor.ts",
      "backend-ts/src/runner/scheduleActionDispatcher.ts",
      "backend-ts/src/schedule/cronSchedule.ts",
      "backend-ts/src/db/repositories/cronTaskClaims.ts",
      "backend-ts/src/db/repositories/cronTaskResults.ts"
    ]
  },
  {
    id: "pi_automation",
    role: "execution",
    tables: ["pi_automations"],
    current_authority: "pi_automations owns native Automation definition, claim cursor, retry, and last execution result",
    target_semantics: "Primary Automation definition/claim authority and governed execution pipeline",
    disposition: "keep",
    duplicate_with: ["cron", "delegation"],
    rollback: "Keep pi_automations dormant while legacy carriers are authoritative; a failed parity or recovery gate restores legacy reads and clears only rebuildable shadow rows by migration batch.",
    final_delete_gate: "Primary authority is not a deletion candidate; only obsolete compatibility fields may be removed by a later P11 ADR after consumer-zero and restore evidence.",
    source_files: [
      "backend-ts/src/runner/piAutomationScheduler.ts",
      "backend-ts/src/pi/automationRunner.ts",
      "backend-ts/src/db/repositories/piAutomations.ts",
      "backend-ts/src/db/repositories/piAutomationScheduler.ts"
    ]
  },
  {
    id: "delegation",
    role: "trigger",
    tables: ["pi_delegations"],
    current_authority: "pi_delegations owns standing-order intent, authorization scope, lifecycle, and next heartbeat cursor",
    target_semantics: "Automation standing order with continuous/scheduled trigger and the same deterministic permission gate",
    disposition: "migrate",
    duplicate_with: ["cron", "pi_automation"],
    rollback: "Before G4 keep delegation lifecycle/cursor authoritative; after G4 legacy delegation routes translate to the sole Automation command and never resume legacy writes concurrently.",
    final_delete_gate: "P11.04/P11.09, no active/paused delegation, authorization mapping parity, heartbeat cursor/restart parity, zero direct consumers for one release, and G7 backup/approval evidence.",
    source_files: [
      "backend-ts/src/pi/heartbeatOrchestrator.ts",
      "backend-ts/src/db/repositories/pi/delegations.ts",
      "backend-ts/src/http/piDelegationsApi.ts"
    ]
  },
  {
    id: "heartbeat",
    role: "execution",
    tables: ["pi_heartbeat_controls", "pi_heartbeat_runs", "pi_heartbeat_events"],
    current_authority: "heartbeat tables own pause control plus tick execution audit; they do not own Work, Run, or Automation definition",
    target_semantics: "Automation trigger executor, recovery signal, and Evidence; never a second standing-order state machine",
    disposition: "merge",
    duplicate_with: ["cron_execution", "pi_automation_execution"],
    rollback: "Preserve heartbeat audit rows; restore the legacy trigger owner on parity failure and do not manufacture core Runs from historical heartbeat ticks.",
    final_delete_gate: "Execution history remains R3 audit; retire only the legacy scheduler/control path after target pause/retry/restart parity, zero live delegation references, and item-specific P11/G7 approval.",
    source_files: [
      "backend-ts/src/pi/heartbeatOrchestrator.ts",
      "backend-ts/src/pi/heartbeatActionExecution.ts",
      "backend-ts/src/db/repositories/pi/heartbeats.ts"
    ]
  },
  {
    id: "completion_watch",
    role: "observation",
    tables: ["pi_issue_completion_watches", "pi_issue_completion_watch_items"],
    current_authority: "completion-watch header/items own condition, target snapshot, idempotency key, and notification progress",
    target_semantics: "Automation completion condition/observation attached to authoritative Work; never execution or completion authority",
    disposition: "migrate",
    duplicate_with: ["supervisor_commitment", "notification_delivery"],
    rollback: "Keep legacy watch observer and startup sweep authoritative through W1; target observation may shadow-compare but must not send a second notification.",
    final_delete_gate: "P11.04/P11.09, zero active/satisfied-undelivered watches, item/status/idempotency/restart parity, notification dedupe proof, one release zero direct consumers, archive/restore, and G7 approval.",
    source_files: [
      "backend-ts/src/pi/issueCompletionWatchEvaluator.ts",
      "backend-ts/src/pi/issueCompletionWatchActions.ts",
      "backend-ts/src/db/repositories/pi/issueCompletionWatches.ts",
      "backend-ts/src/db/repositories/pi/issueCompletionWatchAdmin.ts"
    ]
  },
  {
    id: "nightly_batch",
    role: "archive",
    tables: ["nightly_batches", "nightly_batch_items"],
    current_authority: "live legacy tables are read-only historical records; current source and deployed scheduler have no consumer",
    target_semantics: "Archived legacy export only; historical rows are not backfilled into Automation or Run Group without a new provenance ADR",
    disposition: "delete",
    duplicate_with: ["cron", "run_group"],
    rollback: "No runtime cutover exists; retain both parent/item tables unchanged until a checksum archive and isolated restore are proven.",
    final_delete_gate: "P11.09, export all parent/item rows with mapping and checksums, one release zero runtime/source/API consumers, fresh SQLite backup, isolated restore rehearsal, and explicit non-LLM G7 approval.",
    source_files: ["backend-ts/src/xuanwu/capabilityDispositionInventory.ts"]
  }
] as const satisfies readonly AutomationCarrier[];

export const AUTOMATION_STATUS_MAPPINGS = [
  { carrier: "cron", field: "status", source_status: "active", canonical_status: "enabled", semantic_axis: "definition" },
  { carrier: "cron", field: "status", source_status: "paused", canonical_status: "paused", semantic_axis: "definition" },
  { carrier: "cron", field: "status", source_status: "done", canonical_status: "completed", semantic_axis: "definition" },
  { carrier: "cron", field: "last_status", source_status: "success", canonical_status: "succeeded", semantic_axis: "execution" },
  { carrier: "cron", field: "last_status", source_status: "error", canonical_status: "failed", semantic_axis: "execution" },
  { carrier: "cron", field: "last_status", source_status: "skipped", canonical_status: "skipped", semantic_axis: "execution" },
  { carrier: "pi_automation", field: "enabled", source_status: "1", canonical_status: "enabled", semantic_axis: "definition" },
  { carrier: "pi_automation", field: "enabled", source_status: "0", canonical_status: "paused", semantic_axis: "definition" },
  { carrier: "pi_automation", field: "last_status", source_status: "running", canonical_status: "running", semantic_axis: "execution" },
  { carrier: "pi_automation", field: "last_status", source_status: "success", canonical_status: "succeeded", semantic_axis: "execution" },
  { carrier: "pi_automation", field: "last_status", source_status: "error", canonical_status: "failed", semantic_axis: "execution" },
  { carrier: "delegation", field: "status", source_status: "active", canonical_status: "enabled", semantic_axis: "definition" },
  { carrier: "delegation", field: "status", source_status: "paused", canonical_status: "paused", semantic_axis: "definition" },
  { carrier: "delegation", field: "status", source_status: "expired", canonical_status: "completed", semantic_axis: "definition" },
  { carrier: "heartbeat", field: "status", source_status: "running", canonical_status: "running", semantic_axis: "execution" },
  { carrier: "heartbeat", field: "status", source_status: "completed", canonical_status: "succeeded", semantic_axis: "execution" },
  { carrier: "heartbeat", field: "status", source_status: "failed", canonical_status: "failed", semantic_axis: "execution" },
  { carrier: "heartbeat", field: "status", source_status: "skipped", canonical_status: "skipped", semantic_axis: "execution" },
  { carrier: "completion_watch", field: "status", source_status: "active", canonical_status: "watching", semantic_axis: "observation" },
  { carrier: "completion_watch", field: "status", source_status: "satisfied", canonical_status: "satisfied", semantic_axis: "observation" },
  { carrier: "completion_watch", field: "status", source_status: "notified", canonical_status: "delivered", semantic_axis: "observation" },
  { carrier: "completion_watch", field: "status", source_status: "cancelled", canonical_status: "cancelled", semantic_axis: "observation" },
  { carrier: "completion_watch", field: "status", source_status: "failed", canonical_status: "failed", semantic_axis: "observation" },
  { carrier: "nightly_batch", field: "status", source_status: "active", canonical_status: "legacy_active", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "status", source_status: "paused", canonical_status: "legacy_paused", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "status", source_status: "done", canonical_status: "archived_terminal", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "item.status", source_status: "pending", canonical_status: "legacy_pending", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "item.status", source_status: "current", canonical_status: "legacy_running", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "item.status", source_status: "done", canonical_status: "archived_terminal", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "item.status", source_status: "failed", canonical_status: "archived_failed", semantic_axis: "archive" },
  { carrier: "nightly_batch", field: "item.status", source_status: "skipped", canonical_status: "archived_skipped", semantic_axis: "archive" }
] as const satisfies readonly AutomationStatusMapping[];

export const AUTOMATION_API_ROUTES = [
  { method: "GET", path: "/api/cron-tasks", role: "observation", write: false },
  { method: "POST", path: "/api/cron-tasks", role: "definition", write: true },
  { method: "DELETE", path: "/api/cron-tasks/:id", role: "definition", write: true },
  { method: "PATCH", path: "/api/cron-tasks/:id", role: "control", write: true },
  { method: "GET", path: "/api/pi/automations", role: "observation", write: false },
  { method: "POST", path: "/api/pi/automations", role: "definition", write: true },
  { method: "GET", path: "/api/pi/automations/:id", role: "observation", write: false },
  { method: "PATCH", path: "/api/pi/automations/:id", role: "control", write: true },
  { method: "GET", path: "/api/pi/automations/runnable", role: "observation", write: false },
  { method: "GET", path: "/api/pi/delegations", role: "observation", write: false },
  { method: "POST", path: "/api/pi/delegations", role: "definition", write: true },
  { method: "GET", path: "/api/pi/delegations/:id", role: "observation", write: false },
  { method: "PATCH", path: "/api/pi/delegations/:id", role: "control", write: true },
  { method: "POST", path: "/api/pi/delegations/:id/expire", role: "control", write: true },
  { method: "POST", path: "/api/pi/delegations/:id/pause", role: "control", write: true },
  { method: "POST", path: "/api/pi/delegations/:id/resume", role: "control", write: true },
  { method: "GET", path: "/api/pi/heartbeat-timeline", role: "observation", write: false },
  { method: "GET", path: "/api/pi/issue-completion-watches", role: "observation", write: false },
  { method: "GET", path: "/api/pi/issue-completion-watches/:id", role: "observation", write: false },
  { method: "POST", path: "/api/pi/issue-completion-watches/:id/cancel", role: "control", write: true },
  { method: "GET", path: "/api/projects/:id/pi/heartbeat/diagnostics", role: "observation", write: false },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/pause", role: "control", write: true },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/resume", role: "control", write: true },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/run-once", role: "trigger", write: true },
  { method: "POST", path: "/api/projects/:id/pi/pause", role: "control", write: true },
  { method: "POST", path: "/api/projects/:id/pi/resume", role: "control", write: true },
  { method: "POST", path: "/api/projects/:id/pi/run-once", role: "trigger", write: true }
] as const satisfies readonly AutomationRoute[];

export const AUTOMATION_MIGRATION_CONTRACT = {
  current_gate: "G0",
  current_window: "W0",
  target_authority: "pi_automations plus one governed Automation command/claim pipeline; Work, Run, Approval, Attention, and delivery retain their own authorities",
  dual_read: "W1 legacy-primary shadow comparison, then W2 target-primary deterministic comparison/fallback; W1+W2 is at most two consecutive formal releases.",
  dual_write: "Default forbidden. W1 permits only idempotent target shadow writes owned by a migration batch; at G4/W2 target becomes the sole writer and legacy APIs translate to the same command.",
  rollback: "Parity failure keeps/restores the legacy carrier, disables shadow/target read, and blocks the next gate. After G4, stop the target writer and replay only the audited cutover delta before restoring legacy authority.",
  permission: "LLM output may propose an Automation but cannot approve a state change, external write, cutover, rollback, or destructive action; deterministic policy/Approval and audit are mandatory.",
  notification_boundary: "A watch observes authoritative Work; Attention records a need; Approval authorizes; Notification/outbox delivers. None of them proves Work completion or becomes Automation execution authority.",
  migration_order: [
    "Freeze carrier IDs, status/cursor mapping, writer/consumer inventory, and live baseline.",
    "Route new commands through one deterministic Automation command seam while every legacy carrier remains the sole storage authority.",
    "Add only reversible target mappings, then backfill and shadow-compare definitions, cursors, status, claims, and watch idempotency during W1.",
    "In W2 switch reads first; after parity and non-LLM approval, switch to one target writer and make legacy APIs translation-only.",
    "Run W3 target-only through restart, missed-trigger, retry, pause, watch-dedupe, and external-delivery recovery; prove zero legacy storage consumers.",
    "Only P11/G7 may remove compatibility code or tables after archive, fresh backup, isolated restore, and item-specific delete gates."
  ]
} as const;

export const AUTOMATION_TABLES = AUTOMATION_CARRIERS.flatMap((carrier) => [...carrier.tables]);
