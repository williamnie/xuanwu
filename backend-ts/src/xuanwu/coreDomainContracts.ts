export const CORE_OBJECT_KINDS = [
  "work",
  "run",
  "evidence",
  "handoff",
  "attention",
  "automation"
] as const;

export type CoreObjectKind = typeof CORE_OBJECT_KINDS[number];
export type DomainID<Kind extends CoreObjectKind = CoreObjectKind> = `xw:${Kind}:${string}:${string}`;
export type WorkID = DomainID<"work">;
export type RunID = DomainID<"run">;
export type EvidenceID = DomainID<"evidence">;
export type HandoffID = DomainID<"handoff">;
export type AttentionID = DomainID<"attention">;
export type AutomationID = DomainID<"automation">;

export const DOMAIN_ID_AUTHORITIES = {
  work: ["issues"],
  run: ["issue_runs"],
  evidence: ["issue_events", "pi_action_events", "issue_supervisor_events", "git"],
  handoff: ["derived"],
  attention: ["attention_inbox_items", "pi_guardian_alerts", "pi_approval_requests", "pi_actions", "issues"],
  automation: ["pi_automations", "cron_tasks", "pi_delegations"]
} as const satisfies Record<CoreObjectKind, readonly string[]>;

export const WORK_STATUSES = [
  "triage",
  "todo",
  "in_progress",
  "pending_verification",
  "done",
  "failed",
  "cancelled"
] as const;
export const RUN_STATUSES = ["created", "running", "recovering", "succeeded", "failed", "cancelled"] as const;
export const EVIDENCE_STATUSES = ["pending", "passed", "failed", "blocked"] as const;
export const HANDOFF_STATUSES = ["draft", "ready", "delivered", "superseded"] as const;
export const ATTENTION_STATUSES = ["open", "acknowledged", "waiting", "resolved", "dismissed"] as const;
export const AUTOMATION_STATUSES = ["draft", "active", "paused", "archived"] as const;

export type WorkStatus = typeof WORK_STATUSES[number];
export type RunStatus = typeof RUN_STATUSES[number];
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];
export type HandoffStatus = typeof HANDOFF_STATUSES[number];
export type AttentionStatus = typeof ATTENTION_STATUSES[number];
export type AutomationStatus = typeof AUTOMATION_STATUSES[number];

export const STATUS_VALUES_BY_KIND = {
  attention: ATTENTION_STATUSES,
  automation: AUTOMATION_STATUSES,
  evidence: EVIDENCE_STATUSES,
  handoff: HANDOFF_STATUSES,
  run: RUN_STATUSES,
  work: WORK_STATUSES
} as const satisfies Record<CoreObjectKind, readonly string[]>;

export const STATE_TRANSITIONS = {
  work: {
    triage: ["todo", "cancelled"],
    todo: ["triage", "in_progress", "cancelled"],
    in_progress: ["todo", "pending_verification", "failed", "cancelled"],
    pending_verification: ["triage", "in_progress", "done", "failed", "cancelled"],
    done: [],
    failed: ["triage", "todo", "pending_verification", "cancelled"],
    cancelled: []
  },
  run: {
    created: ["running", "cancelled"],
    running: ["recovering", "succeeded", "failed", "cancelled"],
    recovering: ["running", "succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: []
  },
  evidence: {
    pending: ["passed", "failed", "blocked"],
    passed: [],
    failed: [],
    blocked: []
  },
  handoff: {
    draft: ["ready", "superseded"],
    ready: ["delivered", "superseded"],
    delivered: ["superseded"],
    superseded: []
  },
  attention: {
    open: ["acknowledged", "waiting", "resolved", "dismissed"],
    acknowledged: ["waiting", "resolved", "dismissed"],
    waiting: ["acknowledged", "resolved", "dismissed"],
    resolved: [],
    dismissed: []
  },
  automation: {
    draft: ["active", "archived"],
    active: ["paused", "archived"],
    paused: ["active", "archived"],
    archived: []
  }
} as const;

export const DOMAIN_EVENT_NAMES = [
  "work.created.v1",
  "work.status_changed.v1",
  "run.created.v1",
  "run.status_changed.v1",
  "run.recovery_requested.v1",
  "evidence.recorded.v1",
  "evidence.superseded.v1",
  "handoff.prepared.v1",
  "handoff.delivery_requested.v1",
  "handoff.delivery_completed.v1",
  "handoff.delivery_failed.v1",
  "handoff.superseded.v1",
  "attention.opened.v1",
  "attention.status_changed.v1",
  "automation.created.v1",
  "automation.status_changed.v1",
  "automation.triggered.v1"
] as const;

export type DomainEventName = typeof DOMAIN_EVENT_NAMES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DomainRef<Kind extends CoreObjectKind = CoreObjectKind> = { id: DomainID<Kind>; kind: Kind };
export type ProjectOwner = { kind: "project"; project_id: string };
export type ControlPlaneOwner = { control_plane_id: "local"; kind: "control_plane" };
export type ScopeOwner = ProjectOwner | ControlPlaneOwner;

type Timestamped = { created_at: string; updated_at: string };

export type Work = Timestamped & {
  acceptance_criteria: string[];
  goal: string;
  id: WorkID;
  owner: ProjectOwner;
  source_ref: string;
  status: WorkStatus;
  workflow_ref: string;
};

export type Run = Timestamped & {
  attempt: number;
  ended_at?: string;
  id: RunID;
  provider: string;
  provider_session_ref?: string;
  started_at?: string;
  status: RunStatus;
  work_id: WorkID;
};

export type EvidenceKind =
  | "command"
  | "test"
  | "http_smoke"
  | "human_review"
  | "git_fact"
  | "audit_event"
  | "runtime_fact";

export type Evidence = Timestamped & {
  artifact_refs: string[];
  id: EvidenceID;
  kind: EvidenceKind;
  producer: string;
  revision?: string;
  run_id?: RunID;
  status: EvidenceStatus;
  summary: string;
  supersedes_id?: EvidenceID;
  work_id: WorkID;
};

export type DeliveryAction = {
  action: "commit" | "push" | "pull_request" | "release" | "deploy" | "tracker_update";
  after_ref?: string;
  audit_event_ref: string;
  before_ref?: string;
  gate_decision: "allow" | "deny" | "ask";
  outcome: "not_executed" | "succeeded" | "failed";
  rollback_ref?: string;
  target: string;
};

export type Handoff = Timestamped & {
  baseline_revision: string;
  changed_files: string[];
  delivery_actions: DeliveryAction[];
  evidence_ids: EvidenceID[];
  final_revision: string;
  id: HandoffID;
  review_ref: string;
  status: HandoffStatus;
  summary: string;
  supersedes_id?: HandoffID;
  work_id: WorkID;
};

export type Attention = Timestamped & {
  evidence_ids: EvidenceID[];
  id: AttentionID;
  next_action: string;
  owner: ScopeOwner;
  related_refs: string[];
  reason_code: string;
  required_actor: string;
  status: AttentionStatus;
  subject_refs: DomainRef[];
  summary: string;
};

export type AutomationMode = "observe" | "propose" | "execute_allowed";
export type Automation = Timestamped & {
  id: AutomationID;
  idempotency_namespace: string;
  mode: AutomationMode;
  name: string;
  owner: ScopeOwner;
  permission_policy_ref: string;
  status: AutomationStatus;
  trigger: { config: Record<string, JsonValue>; type: "manual" | "schedule" | "continuous" | "webhook" };
};

export type DomainActor = {
  id: string;
  kind: "user" | "supervisor" | "runner" | "guardian" | "automation" | "system";
};

export type AuditedEffect = {
  after_ref?: string;
  before_ref?: string;
  classification: "state_change" | "external_write" | "destructive";
  gate_decision: "allow" | "deny" | "ask";
  operation: string;
  outcome: "not_executed" | "succeeded" | "failed";
  target: string;
};

export type DomainEvent = {
  actor: DomainActor;
  causation_id?: string;
  correlation_id: string;
  effect?: AuditedEffect;
  event_id: string;
  name: DomainEventName;
  occurred_at: string;
  payload: Record<string, JsonValue>;
  reason: string;
  subject: DomainRef;
};

export type CoreDomainSnapshot = {
  attentions: Attention[];
  automations: Automation[];
  evidence: Evidence[];
  handoffs: Handoff[];
  runs: Run[];
  works: Work[];
};

// 子对象只指向唯一父对象；Attention 与 Automation 以 scope 为所有者，只引用而不拥有 Work。
export const CORE_OWNERSHIP_PARENT: Readonly<Record<CoreObjectKind, CoreObjectKind | null>> = {
  work: null,
  run: "work",
  evidence: "work",
  handoff: "work",
  attention: null,
  automation: null
};

export function makeDomainID<Kind extends CoreObjectKind>(
  kind: Kind,
  authority: typeof DOMAIN_ID_AUTHORITIES[Kind][number],
  localID: number | string
): DomainID<Kind> {
  const value = String(localID).trim();
  if (!DOMAIN_ID_AUTHORITIES[kind].includes(authority as never)) {
    throw new Error(`unsupported ${kind} id authority: ${authority}`);
  }
  if (value === "") throw new Error(`${kind} local id is required`);
  return `xw:${kind}:${authority}:${rfc3986Encode(value)}` as DomainID<Kind>;
}

export function parseDomainID(id: string): { authority: string; kind: CoreObjectKind; local_id: string } | null {
  const match = /^xw:([a-z]+):([a-z][a-z0-9_]*):([A-Za-z0-9._~%-]+)$/.exec(id);
  if (!match || !CORE_OBJECT_KINDS.includes(match[1] as CoreObjectKind)) return null;
  const kind = match[1] as CoreObjectKind;
  if (!DOMAIN_ID_AUTHORITIES[kind].includes(match[2] as never)) return null;
  try {
    const localID = decodeURIComponent(match[3]);
    return localID === "" ? null : { authority: match[2], kind, local_id: localID };
  } catch {
    return null;
  }
}

export function canTransition<Kind extends keyof typeof STATE_TRANSITIONS>(
  kind: Kind,
  from: keyof typeof STATE_TRANSITIONS[Kind],
  to: string
): boolean {
  const targets = STATE_TRANSITIONS[kind][from] as readonly string[];
  return targets.includes(to);
}

export function assertAcyclicOwnership(
  parents: Readonly<Record<CoreObjectKind, CoreObjectKind | null>> = CORE_OWNERSHIP_PARENT
): void {
  for (const start of CORE_OBJECT_KINDS) {
    const seen = new Set<CoreObjectKind>();
    let current: CoreObjectKind | null = start;
    while (current !== null) {
      if (seen.has(current)) throw new Error(`circular ownership detected at ${current}`);
      seen.add(current);
      current = parents[current];
    }
  }
}

export function validateDomainSnapshot(snapshot: CoreDomainSnapshot): string[] {
  const errors: string[] = [];
  assertAcyclicOwnership();
  const works = uniqueIndex(snapshot.works, "work", errors);
  const runs = uniqueIndex(snapshot.runs, "run", errors);
  const evidence = uniqueIndex(snapshot.evidence, "evidence", errors);
  const handoffs = uniqueIndex(snapshot.handoffs, "handoff", errors);
  uniqueIndex(snapshot.attentions, "attention", errors);
  uniqueIndex(snapshot.automations, "automation", errors);

  const attempts = new Set<string>();
  for (const run of snapshot.runs) {
    if (!works.has(run.work_id)) errors.push(`${run.id} references missing work ${run.work_id}`);
    if (!Number.isSafeInteger(run.attempt) || run.attempt <= 0) errors.push(`${run.id} attempt must be positive`);
    const attemptKey = `${run.work_id}:${run.attempt}`;
    if (attempts.has(attemptKey)) errors.push(`${run.work_id} has duplicate attempt ${run.attempt}`);
    attempts.add(attemptKey);
  }

  for (const item of snapshot.evidence) {
    if (!works.has(item.work_id)) errors.push(`${item.id} references missing work ${item.work_id}`);
    if (item.run_id) {
      const run = runs.get(item.run_id);
      if (!run) errors.push(`${item.id} references missing run ${item.run_id}`);
      else if (run.work_id !== item.work_id) errors.push(`${item.id} and ${item.run_id} have different work owners`);
    }
    if (item.supersedes_id) {
      const previous = evidence.get(item.supersedes_id);
      if (item.supersedes_id === item.id) errors.push(`${item.id} cannot supersede itself`);
      else if (!previous) errors.push(`${item.id} supersedes missing evidence ${item.supersedes_id}`);
      else if (previous.work_id !== item.work_id) errors.push(`${item.id} supersedes evidence owned by another work`);
    }
  }

  for (const handoff of snapshot.handoffs) {
    if (!works.has(handoff.work_id)) errors.push(`${handoff.id} references missing work ${handoff.work_id}`);
    const handoffEvidence = handoff.evidence_ids.map((id) => evidence.get(id)).filter(Boolean) as Evidence[];
    if (handoffEvidence.length !== handoff.evidence_ids.length) errors.push(`${handoff.id} references missing evidence`);
    if (handoffEvidence.some((item) => item.work_id !== handoff.work_id)) {
      errors.push(`${handoff.id} references evidence owned by another work`);
    }
    if (["ready", "delivered"].includes(handoff.status) && !handoffEvidence.some((item) => item.status === "passed")) {
      errors.push(`${handoff.id} requires passed evidence before ${handoff.status}`);
    }
    if (handoff.supersedes_id) {
      const previous = handoffs.get(handoff.supersedes_id);
      if (handoff.supersedes_id === handoff.id) errors.push(`${handoff.id} cannot supersede itself`);
      else if (!previous) errors.push(`${handoff.id} supersedes missing handoff ${handoff.supersedes_id}`);
      else if (previous.work_id !== handoff.work_id) errors.push(`${handoff.id} supersedes handoff owned by another work`);
    }
    for (const action of handoff.delivery_actions) {
      if (!action.audit_event_ref.trim()) errors.push(`${handoff.id} delivery action requires an audit event ref`);
      if (!action.target.trim()) errors.push(`${handoff.id} delivery action requires a target`);
    }
  }

  const knownIDs = new Set<string>([
    ...snapshot.works.map((item) => item.id),
    ...snapshot.runs.map((item) => item.id),
    ...snapshot.evidence.map((item) => item.id),
    ...snapshot.handoffs.map((item) => item.id),
    ...snapshot.attentions.map((item) => item.id),
    ...snapshot.automations.map((item) => item.id)
  ]);
  for (const attention of snapshot.attentions) {
    for (const ref of attention.subject_refs) {
      if (!knownIDs.has(ref.id)) errors.push(`${attention.id} references missing subject ${ref.id}`);
      if (parseDomainID(ref.id)?.kind !== ref.kind) errors.push(`${attention.id} has a mismatched subject kind`);
    }
    for (const id of attention.evidence_ids) if (!evidence.has(id)) errors.push(`${attention.id} references missing evidence ${id}`);
  }

  for (const work of snapshot.works.filter((item) => item.status === "done")) {
    const passed = snapshot.evidence.some((item) => item.work_id === work.id && item.status === "passed");
    const ready = snapshot.handoffs.some((item) => item.work_id === work.id && ["ready", "delivered"].includes(item.status));
    if (!passed) errors.push(`${work.id} cannot be done without passed evidence`);
    if (!ready) errors.push(`${work.id} cannot be done without a ready handoff`);
  }
  return errors;
}

export function validateDomainEvent(event: DomainEvent): string[] {
  const errors: string[] = [];
  if (!event.event_id.trim()) errors.push("event_id is required");
  if (!event.actor.id.trim()) errors.push("actor.id is required");
  if (!event.reason.trim()) errors.push("reason is required");
  if (!event.correlation_id.trim()) errors.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(event.occurred_at))) errors.push("occurred_at must be a timestamp");
  const subject = parseDomainID(event.subject.id);
  if (!subject || subject.kind !== event.subject.kind) errors.push("subject id and kind must match");
  if (event.name.split(".")[0] !== event.subject.kind) errors.push("event name and subject kind must match");
  if (event.name.includes(".status_changed.") && event.effect?.classification !== "state_change") {
    errors.push("status change events require a state_change effect");
  }
  if (event.name.startsWith("handoff.delivery_") &&
    !["external_write", "destructive"].includes(event.effect?.classification ?? "")) {
    errors.push("handoff delivery events require an external_write or destructive effect");
  }
  if (event.effect) {
    if (!event.effect.operation.trim()) errors.push("audited effect operation is required");
    if (!event.effect.target.trim()) errors.push("audited effect target is required");
  }
  return errors;
}

function uniqueIndex<T extends { id: DomainID }>(
  items: T[],
  kind: CoreObjectKind,
  errors: string[]
): Map<T["id"], T> {
  const index = new Map<T["id"], T>();
  for (const item of items) {
    if (parseDomainID(item.id)?.kind !== kind) errors.push(`${item.id} is not a ${kind} id`);
    if (index.has(item.id)) errors.push(`duplicate ${kind} id ${item.id}`);
    index.set(item.id, item);
  }
  return index;
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
