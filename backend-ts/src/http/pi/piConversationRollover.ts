import { readFile, stat } from "node:fs/promises";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent, getPiConversation, type PiConversation } from "../../db/repositories/pi.ts";
import { getImConversationState } from "../../db/repositories/imConversationState.ts";
import { activateImContextRollover, prepareImContextRollover } from "../../db/repositories/imContextLifecycle.ts";
import { resolvePiConversationSessionFile } from "./piConversationTranscript.ts";
import { cleanString, numberValue, objectValue } from "../../util/values.ts";
import type { PiConversationContext, PiConversationPromptInput } from "./piConversationApi.ts";

/** IM conversation context budget: rolls an over-budget IM conversation over to a child conversation. */

/**
 * Rolls an over-budget IM conversation to a child conversation (created through `createChild`) when the
 * projected context crosses its threshold or the provider reported an overflow.
 */
export async function resolveImContextRollover(
  context: PiConversationContext,
  input: PiConversationPromptInput,
  createChild: (body: Record<string, unknown>) => Promise<unknown>,
  forcedTrigger = ""
): Promise<PiConversationPromptInput> {
  const projection = input.channelContextProjection;
  const parentID = cleanString(input.conversationId);
  if (!projection || parentID === "") return input;
  const parent = getPiConversation(context.database, parentID);
  if (!parent) return input;
  const state = getImConversationState(context.database, projection.connectorID, projection.scopeKey);
  if (!state) return input;
  if (state.active_conversation_id !== parentID) {
    return {
      ...input,
      conversationId: state.active_conversation_id,
      channelContextProjection: { ...projection, piConversationID: state.active_conversation_id }
    };
  }
  const trigger = forcedTrigger || await imContextRolloverTrigger(context.database, parent);
  const observed = context.database.sqlite.query<{ id: number }, [string]>(`
    select id from pi_action_events
    where conversation_id=? and event_type='im_context_policy_observed'
    limit 1
  `).get(parentID) !== null;
  if (!observed && forcedTrigger === "") {
    createPiActionEvent(context.database, {
      action_id: `im-context-policy:${parentID}:${crypto.randomUUID()}`,
      actor: "im_context_coordinator",
      conversation_id: parentID,
      decision: "observed",
      event_type: "im_context_policy_observed",
      payload_json: JSON.stringify({ observe_only: true, trigger: trigger || "none" }),
      project_id: parent.project_id,
      reason: "first existing epoch observation before rollover policy"
    });
    return input;
  }
  if (trigger === "") return input;
  const capsule = {
    created_at: new Date().toISOString(),
    parent_conversation_id: parent.id,
    parent_session_ref: parent.pi_session_id,
    project_refs: parent.project_id ? [parent.project_id] : [],
    schema_version: "xw.pi-continuation-capsule.v1",
    summary_unavailable: true,
    trigger
  };
  const rollover = prepareImContextRollover(context.database, {
    baseConversationID: state.base_conversation_id,
    capsule,
    connectorID: projection.connectorID,
    parentConversationID: parent.id,
    parentEpoch: state.epoch,
    scopeKey: projection.scopeKey,
    trigger
  });
  if (!getPiConversation(context.database, rollover.child_conversation_id)) {
    try {
      await createChild({
        id: rollover.child_conversation_id,
        project_id: parent.project_id,
        title: parent.title
      });
    } catch (error) {
      if (!getPiConversation(context.database, rollover.child_conversation_id)) throw error;
    }
  }
  const activated = activateImContextRollover(context.database, rollover.id);
  if (!activated.activated) {
    const winner = getImConversationState(context.database, projection.connectorID, projection.scopeKey);
    if (!winner || winner.active_conversation_id === parent.id) {
      throw new Error("IM context rollover compare-and-set failed without an active child");
    }
    return {
      ...input,
      conversationId: winner.active_conversation_id,
      channelContextProjection: { ...projection, piConversationID: winner.active_conversation_id }
    };
  }
  createPiActionEvent(context.database, {
    action_id: `im-context-rollover:${activated.rollover.id}`,
    actor: "im_context_coordinator",
    conversation_id: activated.rollover.child_conversation_id,
    decision: "activated",
    event_type: "im_context_rollover_activated",
    payload_json: JSON.stringify({
      child_conversation_id: activated.rollover.child_conversation_id,
      parent_conversation_id: parent.id,
      rollover_id: activated.rollover.id,
      trigger
    }),
    project_id: parent.project_id,
    reason: "activated bounded PI Session rollover"
  });
  return {
    ...input,
    channelContextProjection: {
      ...projection,
      piConversationID: activated.rollover.child_conversation_id
    },
    continuationContext: [
      "PI Session continuation capsule (bounded references; current state must be refreshed through tools):",
      JSON.stringify(capsule)
    ].join("\n"),
    conversationId: activated.rollover.child_conversation_id,
    title: parent.title
  };
}

async function imContextRolloverTrigger(db: RunnerDatabase, conversation: PiConversation): Promise<string> {
  const latestBudget = jsonRecord(db.sqlite.query<{ payload_json: string }, [string]>(`
    select payload_json from pi_action_events
    where conversation_id=? and event_type='runtime_context_budget_observed'
      and json_valid(payload_json) and json_extract(payload_json, '$.phase')='preflight'
    order by id desc limit 1
  `).get(conversation.id)?.payload_json ?? "{}");
  const percent = numberValue(objectValue(latestBudget?.context).projected_input_percent);
  if (percent >= 60) return "projected_context_threshold";
  const metrics = await piSessionFileMetrics(resolvePiConversationSessionFile(conversation.session_file));
  if (metrics.compactions >= 2) return "compaction_count";
  if (metrics.userTurns >= 50) return "user_turn_count";
  if (metrics.bytes >= 1_000_000) return "session_file_size";
  return "";
}

async function piSessionFileMetrics(path: string): Promise<{ bytes: number; compactions: number; userTurns: number }> {
  if (path === "") return { bytes: 0, compactions: 0, userTurns: 0 };
  try {
    const metadata = await stat(path);
    if (metadata.size >= 1_000_000) return { bytes: metadata.size, compactions: 0, userTurns: 0 };
    const text = await readFile(path, "utf8");
    let compactions = 0;
    let userTurns = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const entry = jsonRecord(line);
      if (entry.type === "compaction") compactions += 1;
      if (entry.type === "message" && objectValue(entry.message).role === "user") userTurns += 1;
    }
    return { bytes: metadata.size, compactions, userTurns };
  } catch {
    return { bytes: 0, compactions: 0, userTurns: 0 };
  }
}

export function isContextOverflow(error: unknown): boolean {
  return /context.{0,40}(overflow|window|length)|too many tokens/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function jsonRecord(value: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
}
