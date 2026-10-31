import type { DomainActor, WorkID } from "../../xuanwu/coreDomainContracts.ts";

export const READINESS_REQUIREMENTS_EVENT_TYPE = "work.readiness_requirements.declared.v1";

export const READINESS_REQUIREMENTS_SCHEMA_VERSION = 1 as const;

export const READINESS_PROJECTION_CONTRACT = "xw.delivery-readiness.projection.v1" as const;

export const READINESS_STAGES = ["source_ready", "deployed", "observed", "gate_passed"] as const;

export type ReadinessStage = typeof READINESS_STAGES[number];

export const READINESS_EVIDENCE_EVENTS = ["deployment", "observation", "gate_pass", "rollback"] as const;

export type ReadinessEvidenceEvent = typeof READINESS_EVIDENCE_EVENTS[number];

export type ReadinessAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  occurred_at: string;
  reason: string;
};

export type ReadinessRequirement = {
  environment: string;
  migration_gate?: string;
  release_window: string;
  required_stage: ReadinessStage;
  runtime_revision: string;
  source_revision: string;
  source_work_id: WorkID;
};

export type ReadinessRequirementDeclaration = {
  audit: ReadinessAudit;
  requirements: ReadinessRequirement[];
  schema_version: typeof READINESS_REQUIREMENTS_SCHEMA_VERSION;
  work_id: WorkID;
};

export type ReadinessRequirementProjection = ReadinessRequirement & {
  current_stage: ReadinessStage | null;
  evidence_ids: string[];
  missing_evidence: string[];
  next_step: string;
  ready: boolean;
  rollback_evidence_id: string;
  source_issue_id: number | null;
  source_status: string;
};

export type ReadinessProjection = {
  contract: typeof READINESS_PROJECTION_CONTRACT;
  current_stage: ReadinessStage | null;
  declared_at: string;
  declaration_event_id: number | null;
  missing_evidence: string[];
  next_step: string;
  ready: boolean;
  requirements: ReadinessRequirementProjection[];
  status: "not_required" | "ready" | "waiting" | "invalid";
  work_id: WorkID;
};

export type ReadinessEvidenceFacts = {
  environment: string;
  event: ReadinessEvidenceEvent;
  migration_gate: string;
  release_window: string;
  rollback_ref: string;
  runtime_revision: string;
  runtime_stamp: string;
  source_revision: string;
};

export type DeclarationEventRow = { created_at: string; id: number; payload: string };
