import type { RunnerDatabase } from "../db/database.ts";
import {
  listExternalLinksByIssue,
  listExternalLinksByProject
} from "../db/repositories/externalLinks.ts";
import type { ImTargetV1 } from "./imChannelContracts.ts";
import { findImConversationStateByConversationID } from "../db/repositories/imConversationState.ts";

export type ResolvedImNotificationTarget = ImTargetV1 & { external_event_id: number };
export type ResolveImNotificationTargetInput = {
  connectorID: string;
  conversationID?: string;
  issueID?: number;
  projectID?: string;
};

/**
 * Recover an opaque IM target from shared external facts. The resolver never
 * parses connector-specific id prefixes or conversation naming conventions;
 * provider compatibility codecs remain inside their channel module.
 */
export function resolveImNotificationTarget(
  db: RunnerDatabase,
  input: ResolveImNotificationTargetInput
): ResolvedImNotificationTarget | null {
  const connectorID = required(input.connectorID, "connectorID");
  const links = candidateLinks(db, {
    connectorID,
    conversationID: clean(input.conversationID),
    issueID: positiveInteger(input.issueID),
    projectID: clean(input.projectID)
  });
  for (const link of links) {
    const target = targetFromLink(db, connectorID, link);
    if (target) return target;
  }
  return null;
}

/** Infer a connector only when shared facts identify exactly one IM source. */
export function resolveImNotificationConnectorID(db: RunnerDatabase, input: {
  conversationID?: string;
  issueID?: number;
  projectID?: string;
}): string {
  const conversationID = clean(input.conversationID);
  const persisted = findImConversationStateByConversationID(db, conversationID);
  if (persisted) return persisted.connector_id;
  const issueID = positiveInteger(input.issueID);
  const projectID = clean(input.projectID);
  const rows = db.sqlite.query<{ source: string }, Array<number | string>>(
    `select distinct l.source from external_links l
     join external_events e on e.id=l.external_event_id
     where l.external_event_id>0
       and (?='' or l.conversation_id=?)
       and (?=0 or l.issue_id=?)
       and (?='' or l.project_id=?)
       and (json_extract(e.normalized_message_json, '$.conversation.id')<>''
         or json_extract(e.normalized_message_json, '$.chat_id')<>'')
     order by l.source`,
  ).all(conversationID, conversationID, issueID, issueID, projectID, projectID)
    .map((row) => clean(row.source)).filter(Boolean);
  return rows.length === 1 ? rows[0]! : "";
}

function candidateLinks(
  db: RunnerDatabase,
  input: { connectorID: string; conversationID: string; issueID: number; projectID: string }
) {
  const issueLinks = input.issueID > 0
    ? listExternalLinksByIssue(db, input.issueID).filter((link) => link.source === input.connectorID)
    : [];
  const conversationLinks = input.conversationID === "" ? [] : db.sqlite.query<{
    conversation_id: string; external_event_id: number; external_id: string;
    external_type: string; relationship: string; source: string;
  }, [string, string]>(
    `select conversation_id, external_event_id, external_id, external_type, relationship, source
     from external_links where source=? and conversation_id=? and external_event_id>0
     order by created_at desc, id desc`
  ).all(input.connectorID, input.conversationID);
  const projectLinks = input.projectID === ""
    ? []
    : listExternalLinksByProject(db, input.projectID).filter((link) => link.source === input.connectorID);
  return uniqueLinks([
    ...prioritize(issueLinks),
    ...prioritize(conversationLinks),
    ...prioritize(projectLinks)
  ]);
}

function prioritize<T extends { external_event_id: number; relationship: string }>(links: T[]): T[] {
  return [...links]
    .filter((link) => link.external_event_id > 0)
    .sort((left, right) => Number(right.relationship === "notification") - Number(left.relationship === "notification"));
}

function uniqueLinks<T extends { external_event_id: number }>(links: T[]): T[] {
  const seen = new Set<number>();
  return links.filter((link) => {
    if (seen.has(link.external_event_id)) return false;
    seen.add(link.external_event_id);
    return true;
  });
}

function targetFromLink(
  db: RunnerDatabase,
  connectorID: string,
  link: { external_event_id: number; external_id: string }
): ResolvedImNotificationTarget | null {
  const event = db.sqlite.query<{
    normalized_message_json: string; provider: string; source: string;
  }, [number]>(
    "select normalized_message_json, provider, source from external_events where id=?"
  ).get(link.external_event_id);
  if (!event || (event.source !== connectorID && event.provider !== connectorID)) return null;
  const normalized = object(event.normalized_message_json);
  const conversation = object(normalized.conversation);
  const thread = object(normalized.thread);
  const conversationID = clean(conversation.id) || clean(normalized.chat_id);
  const replyToMessageID = clean(normalized.message_id) || clean(link.external_id);
  const threadID = clean(thread.id) || clean(normalized.thread_id) || clean(normalized.root_id);
  if (conversationID === "" && replyToMessageID === "" && threadID === "") return null;
  return {
    connector_id: connectorID,
    conversation_id: conversationID,
    external_event_id: link.external_event_id,
    ...(replyToMessageID ? { reply_to_message_id: replyToMessageID } : {}),
    ...(threadID ? { thread_id: threadID } : {})
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(value: unknown, label: string): string {
  const text = clean(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
