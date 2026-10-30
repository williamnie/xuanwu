import { type Static } from "@sinclair/typebox";
import { type DomainActor, type EvidenceID, type EvidenceStatus, type HandoffID, type HandoffStatus, type RunID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import type { HANDOFF_SCHEMA, DeliveryMode, DeliveryActionKind } from "./contracts.schema.ts";

export type HandoffSchemaValue = Static<typeof HANDOFF_SCHEMA>;

export type HandoffRecord = Omit<
  HandoffSchemaValue,
  "evidence_ids" | "id" | "run_ids" | "supersedes_id" | "work_id"
> & {
  evidence_ids: EvidenceID[];
  id: HandoffID;
  run_ids: RunID[];
  supersedes_id?: HandoffID;
  work_id: WorkID;
};

export type HandoffDeliveryAction = HandoffRecord["delivery_actions"][number];

export type HandoffLinkContext = {
  evidence: Array<{ id: EvidenceID; status: EvidenceStatus; work_id: WorkID }>;
  runs: Array<{ id: RunID; work_id: WorkID }>;
};

export type HandoffValidationResult = { errors: string[]; ok: boolean };

export type HandoffTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type HandoffTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: HandoffTransitionGate;
  occurred_at: string;
  reason: string;
};

export type HandoffTransitionCommand = {
  audit: HandoffTransitionAudit;
  expected_revision: number;
  handoff_id: HandoffID;
  superseding_handoff_id?: HandoffID;
  to: Exclude<HandoffStatus, "draft">;
};

export type HandoffTransitionDecision = { allowed: boolean; violations: string[] };

export const REQUIRED_ACTIONS_BY_MODE: Readonly<Record<DeliveryMode, readonly DeliveryActionKind[]>> = {
  local_changes: [],
  branch_commit: ["commit"],
  push: ["commit", "push"],
  draft_pr: ["commit", "push", "pull_request"],
  ready_pr: ["commit", "push", "pull_request"],
  deploy: ["deploy"],
  release: ["release"]
};
