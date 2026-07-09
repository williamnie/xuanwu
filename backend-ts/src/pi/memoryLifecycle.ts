import type { RunnerDatabase } from "../db/database.ts";
import {
  deletePiMemoryItem,
  getPiMemoryItem,
  listPiMemoryItems,
  updatePiMemoryItem,
  type PiMemoryItem
} from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "./memoryPolicy.ts";

export type PiMemoryDigestWindow = "daily" | "weekly";
export type PiMemoryBatchAction = "approve" | "disable" | "forget" | "pin" | "promote";
export type PiMemoryDigestInput = {
  candidateMaxAgeDays?: number;
  now?: Date;
  scope?: string;
  scopeId?: string;
  window?: string;
};
export type PiMemoryBatchInput = { action: PiMemoryBatchAction; ids: string[] };

type DigestRecommendation = "forget" | "promote" | "review";
type DigestGroup = {
  group_key: string;
  items: DigestItem[];
  layer: string;
  memory_type: string;
  scope: string;
  scope_id: string;
};
type DigestItem = {
  content: string;
  id: string;
  kind: string;
  reason: string;
  recommended_action: DigestRecommendation;
  requires_user_confirmation: boolean;
};

const DEFAULT_CANDIDATE_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function buildPiMemoryDigestDraft(db: RunnerDatabase, input: PiMemoryDigestInput = {}) {
  const policy = expiryPolicy(input);
  const items = listPiMemoryItems(db, {
    disabled: 1,
    scope: clean(input.scope),
    scopeId: clean(input.scopeId)
  });
  const groups = groupedDigestItems(items, policy.now, policy.candidateMaxAgeDays);
  return {
    expiry_policy: {
      candidate_max_age_days: policy.candidateMaxAgeDays,
      stale_candidate_action: "forget",
      stale_before_at: iso(daysBefore(policy.now, policy.candidateMaxAgeDays))
    },
    generated_at: iso(policy.now),
    groups,
    period: digestPeriod(input.window, policy.now),
    recommended_batches: recommendedBatches(groups),
    totals: digestTotals(groups),
    window: digestWindow(input.window)
  };
}

export function applyPiMemoryBatchAction(db: RunnerDatabase, input: PiMemoryBatchInput) {
  const ids = uniqueIDs(input.ids);
  if (input.action === "forget") return forgetBatch(db, ids, input.action);
  const updated = ids.flatMap((id) => updateBatchItem(db, id, input.action));
  return { action: input.action, skipped: ids.filter((id) => !updated.includes(id)), updated };
}

function groupedDigestItems(items: PiMemoryItem[], now: Date, maxAgeDays: number): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const item of items) {
    const key = groupKey(item);
    const group = groups.get(key) ?? createGroup(item, key);
    group.items.push(digestItem(item, now, maxAgeDays));
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.group_key.localeCompare(right.group_key));
}

function digestItem(item: PiMemoryItem, now: Date, maxAgeDays: number): DigestItem {
  const recommendation = recommendedAction(item, now, maxAgeDays);
  return {
    content: item.content,
    id: item.id,
    kind: item.kind,
    reason: recommendation.reason,
    recommended_action: recommendation.action,
    requires_user_confirmation: recommendation.requiresConfirmation
  };
}

function recommendedAction(item: PiMemoryItem, now: Date, maxAgeDays: number) {
  if (containsSensitiveMemoryContent(item.content)) {
    return { action: "forget" as const, reason: "contains_sensitive_data", requiresConfirmation: false };
  }
  if (candidateExpired(item, now, maxAgeDays)) {
    return { action: "forget" as const, reason: "expired_candidate", requiresConfirmation: false };
  }
  if (policyOrPermissionLike(item)) {
    return { action: "review" as const, reason: "policy_or_permission_requires_user_confirmation", requiresConfirmation: true };
  }
  return { action: "promote" as const, reason: "low_risk_candidate_ready_for_review", requiresConfirmation: false };
}

function recommendedBatches(groups: DigestGroup[]): Record<DigestRecommendation, string[]> {
  const batches: Record<DigestRecommendation, string[]> = { forget: [], promote: [], review: [] };
  for (const item of groups.flatMap((group) => group.items)) batches[item.recommended_action].push(item.id);
  return batches;
}

function digestTotals(groups: DigestGroup[]) {
  const items = groups.flatMap((group) => group.items);
  return {
    candidate_count: items.length,
    recommend_forget: items.filter((item) => item.recommended_action === "forget").length,
    recommend_promote: items.filter((item) => item.recommended_action === "promote").length,
    requires_confirmation: items.filter((item) => item.requires_user_confirmation).length
  };
}

function updateBatchItem(db: RunnerDatabase, id: string, action: PiMemoryBatchAction): string[] {
  try {
    if (!getPiMemoryItem(db, id)) return [];
    if (action === "pin") updatePiMemoryItem(db, id, { pinned: 1 });
    else updatePiMemoryItem(db, id, { disabled: action === "disable" ? 1 : 0 });
    return [id];
  } catch {
    return [];
  }
}

function forgetBatch(db: RunnerDatabase, ids: string[], action: PiMemoryBatchAction) {
  const forgotten = ids.filter((id) => deletePiMemoryItem(db, id));
  return { action, forgotten, skipped: ids.filter((id) => !forgotten.includes(id)) };
}

function createGroup(item: PiMemoryItem, key: string): DigestGroup {
  return {
    group_key: key,
    items: [],
    layer: item.layer,
    memory_type: item.memory_type,
    scope: item.scope,
    scope_id: item.scope_id || "runner"
  };
}

function groupKey(item: PiMemoryItem): string {
  return `${item.scope}:${item.scope_id || "runner"}|${item.layer}|${item.memory_type}`;
}

function policyOrPermissionLike(item: PiMemoryItem): boolean {
  const text = `${item.kind} ${item.content} ${item.memory_type}`.toLowerCase();
  return /policy|permission|approval|source policy|workflow|project|repo|repository/.test(text) ||
    /策略|权限|授权|审批|工作流|仓库|项目/.test(text);
}

function candidateExpired(item: PiMemoryItem, now: Date, maxAgeDays: number): boolean {
  const updated = Date.parse(item.updated_at);
  return Number.isFinite(updated) && now.getTime() - updated > maxAgeDays * MS_PER_DAY;
}

function digestPeriod(value: string | undefined, now: Date) {
  const days = digestWindow(value) === "weekly" ? 7 : 1;
  return { since_at: iso(daysBefore(now, days)), until_at: iso(now) };
}

function expiryPolicy(input: PiMemoryDigestInput) {
  return {
    candidateMaxAgeDays: input.candidateMaxAgeDays ?? DEFAULT_CANDIDATE_MAX_AGE_DAYS,
    now: input.now ?? new Date()
  };
}

function digestWindow(value: string | undefined): PiMemoryDigestWindow {
  return clean(value) === "weekly" ? "weekly" : "daily";
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

function uniqueIDs(ids: string[]): string[] {
  return [...new Set(ids.map(clean).filter(Boolean))];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(date: Date): string {
  return date.toISOString();
}
