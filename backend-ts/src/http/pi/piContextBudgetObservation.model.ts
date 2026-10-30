import type { RuntimeSessionInput } from "./piRuntime.ts";
import type { buildPiContextBudgetPreflight } from "./piContextBudgetObservation.buildPiContextBudgetPreflight.ts";

export type PiRuntimeSurface = "feishu" | "internal" | "runner_chat" | "telegram";

export type ObservationInput = Pick<RuntimeSessionInput,
  "conversationID" | "delegationID" | "heartbeatID" | "issueID" | "promptProfile" |
  "source" | "sourceTurn" | "supervisorContext"> & {
    channelContext?: string;
    projectID?: string;
  };

export type PreflightObservation = ReturnType<typeof buildPiContextBudgetPreflight>;

export type ObservationPhase = "compaction_end" | "compaction_start" | "postflight" | "preflight";
