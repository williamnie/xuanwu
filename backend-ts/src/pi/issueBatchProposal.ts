import type { RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { withIssueBodyDependencies } from "./issuePlanningBody.ts";

export const ISSUE_BATCH_MAX_ITEMS = 40;

export type IssueBatchMaterializedItem = {
  id: number;
  ref: string;
  title: string;
};

export type IssueBatchPayloadItem = {
  description: string;
  depends_on_refs: string[];
  recommended_mcp_capabilities: string[];
  recommended_skill_intents: string[];
  ref: string;
  required_mcp_capabilities: string[];
  required_skill_intents: string[];
  title: string;
};

export type IssueBatchPayload = {
  batch_items: IssueBatchPayloadItem[];
  project_id: string;
  status: "triage";
};

export function normalizeIssueBatchPayload(payload: Record<string, unknown>): IssueBatchPayload {
  const projectID = cleanString(payload.project_id);
  if (projectID === "") throw new Error("batch project_id is required");
  const rawItems = Array.isArray(payload.batch_items) ? payload.batch_items : [];
  if (rawItems.length < 2 || rawItems.length > ISSUE_BATCH_MAX_ITEMS) {
    throw new Error(`batch_items must contain 2-${ISSUE_BATCH_MAX_ITEMS} issues`);
  }
  const items = rawItems.map(normalizeBatchItem);
  validateRefs(items);
  stableTopologicalOrder(items);
  return { batch_items: items, project_id: projectID, status: "triage" };
}

export function materializeIssueBatch(
  db: RunnerDatabase,
  rawPayload: Record<string, unknown>
): { count: number; items: IssueBatchMaterializedItem[]; project_id: string; status: "created" } {
  const payload = normalizeIssueBatchPayload(rawPayload);
  const ordered = stableTopologicalOrder(payload.batch_items);
  const createdByRef = new Map<string, IssueBatchMaterializedItem>();
  const createAll = db.transaction(() => {
    for (const item of ordered) {
      const dependencyIDs = item.depends_on_refs.map((ref) => requiredCreatedID(createdByRef, ref));
      const issue = createIssue(db, {
        project_id: payload.project_id,
        title: item.title,
        description: withIssueBodyDependencies(item.description, dependencyIDs),
        depends_on_issue_ids: dependencyIDs,
        required_skill_intents: item.required_skill_intents,
        recommended_skill_intents: item.recommended_skill_intents,
        required_mcp_capabilities: item.required_mcp_capabilities,
        recommended_mcp_capabilities: item.recommended_mcp_capabilities,
        status: "triage"
      }, { createdEventPayload: { batch_ref: item.ref } });
      createdByRef.set(item.ref, { id: issue.id, ref: item.ref, title: issue.title });
    }
    // 所有 ID 存在后再补双向验收引用；与创建同事务，失败不留下半张图。
    for (const item of ordered) {
      const id = requiredCreatedID(createdByRef, item.ref);
      const issue = getIssue(db, id)!;
      const description = issue.description.replace(/\{\{issue:([^{}]+)\}\}/g,
        (_match, ref: string) => `Issue #${requiredCreatedID(createdByRef, ref)}`);
      if (description !== issue.description) updateIssue(db, id, { description });
    }
  });
  createAll();
  return {
    count: payload.batch_items.length,
    items: payload.batch_items.map((item) => requiredCreatedItem(createdByRef, item.ref)),
    project_id: payload.project_id,
    status: "created"
  };
}

function normalizeBatchItem(value: unknown): IssueBatchPayloadItem {
  const item = objectValue(value);
  const ref = cleanString(item.ref);
  const title = cleanString(item.title);
  const description = cleanString(item.description);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref)) {
    throw new Error(`invalid batch issue ref: ${ref || "(empty)"}`);
  }
  if (title === "") throw new Error(`batch issue ${ref} title is required`);
  if (description === "") throw new Error(`batch issue ${ref} description is required`);
  return {
    ref,
    title,
    description,
    depends_on_refs: stringList(item.depends_on_refs),
    required_skill_intents: stringList(item.required_skill_intents),
    recommended_skill_intents: stringList(item.recommended_skill_intents),
    required_mcp_capabilities: stringList(item.required_mcp_capabilities),
    recommended_mcp_capabilities: stringList(item.recommended_mcp_capabilities)
  };
}

function validateRefs(items: IssueBatchPayloadItem[]): void {
  const refs = new Set<string>();
  for (const item of items) {
    if (refs.has(item.ref)) throw new Error(`duplicate batch issue ref: ${item.ref}`);
    refs.add(item.ref);
  }
  for (const item of items) {
    for (const match of item.description.matchAll(/\{\{issue:([^{}]+)\}\}/g)) {
      if (!refs.has(match[1]!)) throw new Error(`batch issue ${item.ref} references unknown ref: ${match[1]}`);
    }
    const dependencies = new Set<string>();
    for (const ref of item.depends_on_refs) {
      if (!refs.has(ref)) throw new Error(`batch issue ${item.ref} depends on unknown ref: ${ref}`);
      if (ref === item.ref) throw new Error(`batch issue ${item.ref} cannot depend on itself`);
      if (dependencies.has(ref)) throw new Error(`batch issue ${item.ref} repeats dependency ref: ${ref}`);
      dependencies.add(ref);
    }
  }
}

function stableTopologicalOrder(items: IssueBatchPayloadItem[]): IssueBatchPayloadItem[] {
  const byRef = new Map(items.map((item) => [item.ref, item]));
  const remaining = new Set(items.map((item) => item.ref));
  const ordered: IssueBatchPayloadItem[] = [];
  while (remaining.size > 0) {
    const ready = items.find((item) => remaining.has(item.ref) &&
      item.depends_on_refs.every((ref) => !remaining.has(ref)));
    if (!ready) throw new Error(`batch dependency graph contains a cycle: ${[...remaining].join(", ")}`);
    ordered.push(requiredBatchItem(byRef, ready.ref));
    remaining.delete(ready.ref);
  }
  return ordered;
}

function requiredBatchItem(items: Map<string, IssueBatchPayloadItem>, ref: string): IssueBatchPayloadItem {
  const item = items.get(ref);
  if (!item) throw new Error(`batch issue ref missing after validation: ${ref}`);
  return item;
}

function requiredCreatedID(items: Map<string, IssueBatchMaterializedItem>, ref: string): number {
  return requiredCreatedItem(items, ref).id;
}

function requiredCreatedItem(items: Map<string, IssueBatchMaterializedItem>, ref: string): IssueBatchMaterializedItem {
  const item = items.get(ref);
  if (!item) throw new Error(`batch dependency was not materialized: ${ref}`);
  return item;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
