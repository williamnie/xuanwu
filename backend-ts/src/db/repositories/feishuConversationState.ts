import type { RunnerDatabase } from "../database.ts";
import {
  adoptImConversationState,
  bumpImConversationEpoch,
  getImConversationState
} from "./imConversationState.ts";

/**
 * W1 compatibility shim over the provider-neutral `im_conversation_state`
 * repository (design 2026-08-02-generic-im-channel-telegram-design.md §7.2).
 * The generic table is the single application writer; this module only keeps
 * the legacy Feishu call-sites and read shape working during the bounded
 * compatibility window.
 *
 * Per the design invariant "IM 会话没有持久化当前项目", active project is no
 * longer persisted: the returned `active_project_id`/`active_project_source`
 * fields are always empty, and the active-project writer is a no-op kept only
 * so the historical API surface keeps compiling until removal lands in W2.
 * The physical `feishu_conversation_state` table stays as a read-only
 * historical carrier; a separate destructive migration removes it.
 */
export const FEISHU_IM_CONNECTOR_ID = "feishu";

export type FeishuConversationState = {
  active_conversation_id: string;
  /** @deprecated Always "" — IM conversation state no longer persists projects. */
  active_project_id: string;
  /** @deprecated Always "" — IM conversation state no longer persists projects. */
  active_project_source: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

export type FeishuActiveProjectSource =
  "explicit_project" | "issue_ref" | "user_switch" | "card_select" | "mapping_default";

export type FeishuConversationEpochInput = {
  baseConversationId: string;
  scopeKey: string;
};

export type FeishuConversationActiveProjectInput = {
  activeConversationId?: string;
  activeProjectId: string;
  scopeKey: string;
  source: FeishuActiveProjectSource;
};

export type FeishuConversationAdoptionInput = {
  activeConversationId: string;
  /** @deprecated Ignored — active project is never persisted. */
  activeProjectId?: string;
  /** @deprecated Ignored — active project is never persisted. */
  activeProjectSource?: string;
  epoch?: number;
  scopeKey: string;
  startedAt?: string;
};

export function getFeishuConversationState(
  db: RunnerDatabase,
  scopeKey: string
): FeishuConversationState | null {
  const state = getImConversationState(db, FEISHU_IM_CONNECTOR_ID, scopeKey);
  return state ? legacyView(state) : null;
}

export function bumpFeishuConversationEpoch(
  db: RunnerDatabase,
  input: FeishuConversationEpochInput,
  timestamp = new Date()
): FeishuConversationState {
  return legacyView(bumpImConversationEpoch(db, {
    baseConversationId: input.baseConversationId,
    connectorId: FEISHU_IM_CONNECTOR_ID,
    scopeKey: input.scopeKey
  }, timestamp));
}

export function adoptFeishuConversationState(
  db: RunnerDatabase,
  input: FeishuConversationAdoptionInput,
  timestamp = new Date()
): FeishuConversationState {
  const existing = getImConversationState(db, FEISHU_IM_CONNECTOR_ID, input.scopeKey);
  if (existing) return legacyView(existing);
  return legacyView(adoptImConversationState(db, {
    activeConversationId: input.activeConversationId,
    // Legacy scopes double as the base conversation id (pre-cutover routing
    // always set baseConversationId = scopeKey).
    baseConversationId: input.scopeKey,
    connectorId: FEISHU_IM_CONNECTOR_ID,
    epoch: input.epoch,
    scopeKey: input.scopeKey,
    startedAt: input.startedAt
  }, timestamp));
}

/**
 * @deprecated No-op: IM conversation state intentionally no longer persists an
 * active project (one-shot project resolution only). Returns the current
 * epoch view so legacy callers keep a stable shape.
 */
export function setFeishuConversationActiveProject(
  db: RunnerDatabase,
  input: FeishuConversationActiveProjectInput,
  _timestamp = new Date()
): FeishuConversationState {
  const scopeKey = cleanString(input.scopeKey);
  const current = getImConversationState(db, FEISHU_IM_CONNECTOR_ID, scopeKey);
  return legacyView(current ?? {
    active_conversation_id: cleanString(input.activeConversationId) || scopeKey,
    base_conversation_id: scopeKey,
    connector_id: FEISHU_IM_CONNECTOR_ID,
    epoch: 0,
    scope_key: scopeKey,
    started_at: "",
    updated_at: ""
  });
}

type NeutralState = {
  active_conversation_id: string;
  base_conversation_id: string;
  connector_id: string;
  epoch: number;
  scope_key: string;
  started_at: string;
  updated_at: string;
};

function legacyView(state: NeutralState): FeishuConversationState {
  return {
    active_conversation_id: state.active_conversation_id,
    active_project_id: "",
    active_project_source: "",
    epoch: state.epoch,
    scope_key: state.scope_key,
    started_at: state.started_at,
    updated_at: state.updated_at
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
