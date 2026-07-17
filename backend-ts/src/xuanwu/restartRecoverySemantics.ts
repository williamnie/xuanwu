export type RestartRecoveryCarrier = {
  id: "work" | "run" | "automation" | "approval" | "im_reply_outbox" | "tracker_outbox";
  authority: string;
  startup_reconciler: string;
  lost_lease: string;
  split_brain: string;
  terminal_rule: string;
  repair: string;
};

// This is a W0 contract, not a second recovery runtime.  Each row names the
// existing writer which is allowed to reconcile its own durable state.
export const RESTART_RECOVERY_CARRIERS = [
  {
    id: "work",
    authority: "issues and issue_events; Work is a compatibility projection until its migration gate",
    startup_reconciler: "recoverInProgressIssues only requeues an unstarted in_progress Issue claim; project loops subsequently claim todo work",
    lost_lease: "An unstarted claim is returned to todo exactly once through the Issue status command and issue.recovery_requeued audit event.",
    split_brain: "The Issue status/revision command is the arbiter; a stale observer cannot reopen done, failed, or cancelled work.",
    terminal_rule: "terminal Issue status is never selected by recovery; only an explicit audited status command may close a Work projection.",
    repair: "Preserve the Issue and issue_events, inspect the latest Run/Attempt and use the existing retry or needs-user path; do not manufacture a second Work."
  },
  {
    id: "run",
    authority: "issue_runs plus run_attempts and run.lifecycle intent/outcome audit",
    startup_reconciler: "recoverInProgressIssues prepares one deterministic recovery Attempt before provider.resume and persists its outcome.",
    lost_lease: "A missing provider session requeues only an unstarted claim; a resumable session creates a recovery Attempt, while transient provider failure remains deferred for PI/Guardian.",
    split_brain: "expected revision, unique attempt sequence, persisted intent, and provider idempotency/session refs arbitrate; observation rows never win over issue_runs.",
    terminal_rule: "terminal Run/Attempt rows are immutable: recovery scans in_progress Issues only and cannot reopen a terminal Run.",
    repair: "Keep intent/outcome audit, classify the failure deterministically, then use the existing recovery budget, retry, or needs-user escalation."
  },
  {
    id: "automation",
    authority: "automation_definitions, automation_runs, and automation_run_events for native P08.03 automation only",
    startup_reconciler: "the existing schedule-layer cycle calls runDueAutomations; its immediate SQLite transaction first expires native leases, then materializes and claims due runs.",
    lost_lease: "expired token lease returns a running native Automation run to queued with bounded backoff; exhausted retries terminally fail and create Guardian Attention.",
    split_brain: "the scheduled-slot idempotency key, immediate transaction, and lease token CAS choose one executor; legacy cron, PI automation, delegation, heartbeat, and watch carriers remain separate authorities.",
    terminal_rule: "succeeded, skipped, and failed run outcomes are terminal; a later trigger materializes a new run instead of changing the old one.",
    repair: "Inspect automation_run_events and Guardian Attention, then use the existing retry budget or explicit audited definition control; never replay a missed cron slot."
  },
  {
    id: "approval",
    authority: "pi_approval_requests for provider approvals; pi_actions plus pi_action_events for internal Action Gate execution",
    startup_reconciler: "no generic approval rewriter runs at startup; existing resolver/action paths replay their exact idempotency binding when invoked.",
    lost_lease: "missing, expired, revoked, or mismatched approval bindings fail closed and are audited; they never become an implicit grant.",
    split_brain: "deterministic gate, exact subject/payload/policy binding, and idempotency key win over LLM, notification, or stale provider observations.",
    terminal_rule: "approved, rejected, cancelled, expired provider requests and completed/failed actions are not reopened or re-dispatched by recovery.",
    repair: "Create an audited ask/deny or resolver retry through the existing carrier; external and dangerous effects still require the deterministic gate and human approval where applicable."
  },
  {
    id: "im_reply_outbox",
    authority: "sync_outbox im_reply rows plus approved im_reply_drafts",
    startup_reconciler: "the existing Feishu dispatcher claims only pending, queued, or retry rows; it does not silently reclaim a persisted sending row.",
    lost_lease: "W0 has no durable IM dispatch lease/fence for sending rows, so startup must fail closed rather than replay an ambiguous external send.",
    split_brain: "approved draft, low-risk policy preflight, and Feishu message receipt remain authoritative; a stale sending row is an Attention/manual-repair condition, not permission to send twice.",
    terminal_rule: "sent and failed delivery records are not reset by startup reconciliation.",
    repair: "Inspect the external receipt and existing audit; record a deterministic repair decision before moving an ambiguous sending row. Do not issue a blind resend."
  },
  {
    id: "tracker_outbox",
    authority: "sync_outbox tracker_update rows, pi_actions/pi_action_events authorization audit, and tracker adapter receipt",
    startup_reconciler: "the tracker dispatcher includes expired sending cooldown leases in its dispatchable scan and reclaims them through its existing claim path.",
    lost_lease: "an expired sending cooldown is reclaimable; retry and failure remain bounded and audited, with terminal failure creating Guardian Attention.",
    split_brain: "dedupe key, external idempotency key, authorization action, and adapter receipt arbitrate; if receipt cannot establish the outcome, hold for deterministic repair rather than resend blindly.",
    terminal_rule: "sent and failed rows remain terminal; recovery creates no new external request for the same dedupe key.",
    repair: "Query the adapter using its request/receipt reference when available, then use the existing retry/failed Attention path with the original correlation and idempotency key."
  }
] as const satisfies readonly RestartRecoveryCarrier[];

export const RESTART_RECOVERY_INVARIANTS = [
  "Every recovery decision reads the current durable authority; projections, LLM output, and cached runtime state cannot win arbitration.",
  "Startup reconciliation is idempotent: repeating it converges to the same durable state or records one existing in-flight intent, never a second uncontrolled external effect.",
  "A lost lease is recovered only by the carrier owning that lease; no cross-carrier scan may reset status, cursor, approval, or outbox state.",
  "Terminal Work, Run, Approval, Automation, and Outbox states never regress during startup recovery.",
  "External writes require persisted intent/idempotency, deterministic permission, and outcome/receipt audit before and after every replay.",
  "Ambiguous external delivery fails closed into Attention or an audited repair action; restart is not evidence that a send did not happen.",
  "W0 has no dual writer or dual read: existing carrier authorities remain sole writers until a separately approved migration gate."
] as const;

export function restartRecoveryCarrier(id: RestartRecoveryCarrier["id"]): RestartRecoveryCarrier {
  const carrier = RESTART_RECOVERY_CARRIERS.find((item) => item.id === id);
  if (!carrier) throw new Error(`unsupported restart recovery carrier: ${id}`);
  return carrier;
}
