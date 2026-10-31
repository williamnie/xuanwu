import {
  type AttemptKind,
  type AttemptTerminalStatus,
  type ProviderAttemptRef,
  type RunID,
  type RunTransitionAudit
} from "./contracts.ts";

export type RunAttemptCommand = {
  audit: RunTransitionAudit;
  expected_attempt_revision: number;
  expected_revision: number;
  issue_run_id: string;
  kind: Exclude<AttemptKind, "initial">;
  previous_attempt_terminal: {
    reason: string;
    source_ref: string;
    status: Extract<AttemptTerminalStatus, "failed" | "interrupted" | "succeeded">;
  };
  provider_ref: Pick<ProviderAttemptRef, "provider"> & Partial<Pick<ProviderAttemptRef, "session_ref">>;
  run_id: RunID;
};

export type RunInterruptCommand = {
  attempt_id: string;
  audit: RunTransitionAudit;
  expected_attempt_revision: number;
  expected_revision: number;
  issue_run_id: string;
  provider_ref: ProviderAttemptRef;
  run_id: RunID;
};

export type NewRunCommand = {
  audit: RunTransitionAudit;
  expected_revision: number;
  issue_run_id: string;
  operation: "retry" | "supersede";
  run_id: RunID;
  service_tier?: string;
  service_tier_provided?: boolean;
};

export type ProviderAttemptStart = {
  invocation_ref: string;
  provider_session_id?: string;
  provider_turn_id?: string;
};

export type NewRunRequestResult = {
  applied: boolean;
  event_id: string;
  issue_id: number;
  operation: NewRunCommand["operation"];
  replayed: boolean;
  requested_sequence: number;
  violations: string[];
};

export type PendingRunCreation = {
  event_id: string;
  issue_id: number;
  operation: NewRunCommand["operation"];
  requested_sequence: number;
  supersedes_run_id: RunID;
};
