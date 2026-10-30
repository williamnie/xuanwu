import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { type ProviderRunInput, type ProviderRunResult, type SessionRef } from "../providers/types.ts";
import { type ExecutionPolicyRequest, type ProviderPolicyContext } from "../providers/core/policyContracts.ts";
import type { ProviderTransport } from "../providers/core/manifest.ts";

export const LIVE_PROVIDER_PAYLOAD_MAX_BYTES = 64 * 1024;

export type RunnerIssueExecutionInput = Omit<ProviderRunInput, "onEvent"> & {
  agentProfileId?: string;
  agentRole?: string;
  bus?: Pick<EventBus, "publish">;
  capabilitySummary?: string;
  database?: RunnerDatabase;
  onLog?: ProviderRunInput["onEvent"];
  onProjectSlotReleased?: (projectID: string) => void;
  onRunComplete?: (output: ProviderRuntimeComplete) => void;
  onRunStart?: (input: ProviderRuntimeStart) => void;
  onRuntimeEvent?: ProviderRunInput["onEvent"];
  selectionReason?: string;
  executionPolicyRequest?: ExecutionPolicyRequest;
  executionPolicyCapabilityRevision?: string;
  executionPolicyResolutionSource?: "default" | "legacy" | "profile" | "project" | "session" | "explicit";
  executionPolicyProviderVersion?: string;
  executionPolicyTransport?: ProviderTransport;
  executionSource?: ProviderPolicyContext["source"];
  issueRunId?: string;
};

export type RunnerIssueRecoveryInput = RunnerIssueExecutionInput & { session: SessionRef };

export type ProviderRuntimeStart = {
  issueId: number;
  metadata: { cwd: string };
  projectId: string;
  provider: string;
};

export type ProviderRuntimeComplete = Omit<ProviderRuntimeStart, "metadata"> & ProviderRunResult;
