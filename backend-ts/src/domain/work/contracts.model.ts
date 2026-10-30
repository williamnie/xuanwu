import { STATE_TRANSITIONS, type DomainActor, type Work as CoreWork, type WorkID, type WorkStatus } from "../../xuanwu/coreDomainContracts.ts";
import type { decision } from "./contracts.transitions.ts";

// P00.04 remains the single source for the shared Work status vocabulary and edge table.
export const WORK_STATE_TRANSITIONS = STATE_TRANSITIONS.work;

export const WORK_TYPES = ["objective", "engineering_task"] as const;

export type WorkType = typeof WORK_TYPES[number];

export const WORK_SOURCE_KINDS = [
  "user_request",
  "issue",
  "supervisor_proposal",
  "automation_trigger",
  "guardian_remediation",
  "import"
] as const;

export type WorkSourceKind = typeof WORK_SOURCE_KINDS[number];

export type CompleteWorkSource = {
  actor: DomainActor;
  authority: string;
  completeness: "complete";
  correlation_id: string;
  external_id: string;
  kind: WorkSourceKind;
  occurred_at: string;
  source_event_id?: string;
};

export type LegacyIncompleteWorkSource = {
  actor?: DomainActor;
  authority: string;
  completeness: "legacy_incomplete";
  correlation_id?: string;
  external_id: string;
  kind: WorkSourceKind;
  missing_fields: string[];
  occurred_at: string;
  source_event_id?: string;
};

export type WorkSource = CompleteWorkSource | LegacyIncompleteWorkSource;

export type WorkProvenance = {
  causes: WorkSource[];
  origin: WorkSource;
};

export type WorkAcceptanceCriterion = {
  description: string;
  id: string;
  required: boolean;
};

export type WorkAcceptanceContract = {
  criteria: WorkAcceptanceCriterion[];
  version: number;
};

export type WorkLedgerEntry = Omit<CoreWork, "acceptance_criteria" | "source_ref"> & {
  acceptance: WorkAcceptanceContract;
  agent_profile_id?: string;
  effective_agent_profile?: {
    id: string;
    model: string;
    name: string;
    provider: string;
    selection_reason: string;
    source: "project_default" | "project_provider" | "strategy" | "work";
  };
  effective_provider?: string;
  provenance: WorkProvenance;
  revision: number;
  title: string;
  type: WorkType;
};

export type WorkRelationAudit = {
  actor: DomainActor;
  audit_event_ref: string;
  correlation_id: string;
  occurred_at: string;
  reason: string;
};

export type ParentChildRelation = WorkRelationAudit & {
  child_work_id: WorkID;
  kind: "parent_child";
  parent_work_id: WorkID;
  relation_id: string;
};

export type DependencyRelation = WorkRelationAudit & {
  depends_on_work_id: WorkID;
  kind: "depends_on";
  relation_id: string;
  work_id: WorkID;
};

export type WorkRelation = ParentChildRelation | DependencyRelation;

export type WorkLedgerSnapshot = {
  relations: WorkRelation[];
  works: WorkLedgerEntry[];
};

export type WorkTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type WorkTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: WorkTransitionGate;
  occurred_at: string;
  reason: string;
};

export type WorkTransitionCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  to: WorkStatus;
  work_id: WorkID;
};

export type WorkTransitionDecision = {
  allowed: boolean;
  violations: string[];
};
