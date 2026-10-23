const CORE_OBJECT_KINDS = [
  "work",
  "run",
  "evidence",
  "handoff",
  "attention",
  "automation"
] as const;

type CoreObjectKind = typeof CORE_OBJECT_KINDS[number];
type DomainID<Kind extends CoreObjectKind = CoreObjectKind> = `xw:${Kind}:${string}:${string}`;
export type WorkID = DomainID<"work">;
export type RunID = DomainID<"run">;
export type EvidenceID = DomainID<"evidence">;
export type HandoffID = DomainID<"handoff">;
export type AttentionID = DomainID<"attention">;

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
  "needs_user",
  "done",
  "failed",
  "cancelled"
] as const;
export const RUN_STATUSES = ["created", "running", "recovering", "succeeded", "failed", "cancelled"] as const;
export const EVIDENCE_STATUSES = ["pending", "passed", "failed", "blocked"] as const;
export const HANDOFF_STATUSES = ["draft", "ready", "delivered", "superseded"] as const;
export const ATTENTION_STATUSES = ["open", "acknowledged", "waiting", "resolved", "dismissed"] as const;

export type WorkStatus = typeof WORK_STATUSES[number];
export type RunStatus = typeof RUN_STATUSES[number];
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];
export type HandoffStatus = typeof HANDOFF_STATUSES[number];
export type AttentionStatus = typeof ATTENTION_STATUSES[number];

export const STATE_TRANSITIONS = {
  work: {
    triage: ["todo", "cancelled"],
    todo: ["triage", "in_progress", "cancelled"],
    in_progress: ["todo", "needs_user", "done", "failed", "cancelled"],
    needs_user: ["in_progress", "done", "failed", "cancelled"],
    done: [],
    failed: ["triage", "todo", "cancelled"],
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
export type DomainRef<Kind extends CoreObjectKind = CoreObjectKind> = { id: DomainID<Kind>; kind: Kind };
type ProjectOwner = { kind: "project"; project_id: string };
type ControlPlaneOwner = { control_plane_id: "local"; kind: "control_plane" };
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

export type DomainActor = {
  id: string;
  kind: "user" | "supervisor" | "runner" | "guardian" | "automation" | "system";
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

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
