import { type DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { type WorkLedgerEntry, type WorkTransitionAudit } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";

export const ISSUE_WORK_WRITE_EVENT = "issue.work_adapter_write";

export type IssueWorkAction = "cancel" | "enqueue" | "retry";

export type IssueWorkPatch = Partial<Pick<WorkLedgerEntry, "agent_profile_id" | "goal" | "title">> & {
  depends_on_issue_ids?: number[];
};

export type IssueWorkCreateCommand = {
  agent_profile_id?: string;
  audit: WorkTransitionAudit;
  depends_on_issue_ids?: number[];
  goal: string;
  project_id: string;
  source?: {
    authority: string;
    external_id: string;
    kind: "automation_trigger";
    source_event_id: string;
  };
  status: "todo" | "triage" | "in_progress";
  title?: string;
  type: "engineering_task";
};

export type IssueWorkUpdateCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  patch: IssueWorkPatch;
  work_id: WorkLedgerEntry["id"];
};

export type IssueWorkActionCommand = {
  action: IssueWorkAction;
  audit: WorkTransitionAudit;
  expected_revision: number;
  work_id: WorkLedgerEntry["id"];
};

export type IssueWorkMutationResult = {
  applied: boolean;
  audit_event_id: string;
  violations: string[];
  work: WorkLedgerEntry;
};

export type StoredAdapterAudit = {
  fingerprint: string;
  outcome: "applied" | "rejected";
  violations: string[];
};

export function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function domainActor(value: unknown): DomainActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const actor = value as Record<string, unknown>;
  const id = cleanString(actor.id);
  const kind = cleanString(actor.kind);
  if (!id || !["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) return undefined;
  return { id, kind: kind as DomainActor["kind"] };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}
