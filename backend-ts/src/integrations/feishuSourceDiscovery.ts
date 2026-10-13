import type { RunnerDatabase } from "../db/database.ts";
import type { FeishuNormalizedMessageEvent } from "./feishuTypes.ts";

export type FeishuDiscoveryCandidate = { id: string; chat_id: string; chat_type: string; user_id: string; message_id: string };
type Session = { config_revision: string; id: string; challenge: string; expires_at: string; created: number; candidates: FeishuDiscoveryCandidate[]; consumed: boolean };
const sessions = new WeakMap<RunnerDatabase, Map<string, Session>>();
const TTL = 120_000;
function store(database: RunnerDatabase, now: number) {
  let entries = sessions.get(database);
  if (!entries) { entries = new Map(); sessions.set(database, entries); }
  for (const [id, session] of entries) if (Date.parse(session.expires_at) <= now) entries.delete(id);
  return entries;
}
export function startFeishuDiscovery(database: RunnerDatabase, now = Date.now(), configRevision = "") {
  const entries = store(database, now);
  // 有界、易失。挑战只用于发现，不改变入站授权策略。
  if (entries.size >= 8) entries.delete(entries.keys().next().value!);
  const session: Session = { config_revision: configRevision, id: crypto.randomUUID(), challenge: `xuanwu-connect-${crypto.randomUUID()}`, created: now, expires_at: new Date(now + TTL).toISOString(), candidates: [], consumed: false };
  entries.set(session.id, session);
  return publicSession(session);
}
export function readFeishuDiscovery(database: RunnerDatabase, id: string, now = Date.now()) {
  const session = store(database, now).get(id);
  return session ? publicSession(session) : null;
}
export function captureFeishuDiscovery(database: RunnerDatabase, event: FeishuNormalizedMessageEvent, now = Date.now()): boolean {
  for (const session of store(database, now).values()) {
    if (event.text.replace(/@_user_\d+/g, "").trim() !== session.challenge) continue;
    if (session.consumed || event.sender.type !== "user" || !event.sender.open_id) return true;
    if (Date.parse(event.timestamp) < session.created - 10_000 || Date.parse(event.timestamp) > now + 10_000) return true;
    const duplicate = session.candidates.some(item => item.message_id === event.message_id || (item.chat_id === event.chat_id && item.user_id === event.sender.open_id));
    if (!duplicate && session.candidates.length < 10) session.candidates.push({ id: crypto.randomUUID(), chat_id: event.chat_id, chat_type: event.chat_type, user_id: event.sender.open_id, message_id: event.message_id });
    return true;
  }
  return /^xuanwu-connect-[0-9a-f-]{36}$/.test(event.text.replace(/@_user_\d+/g, "").trim());
}
export function consumeFeishuDiscovery(database: RunnerDatabase, id: string): void {
  const session = store(database, Date.now()).get(id);
  if (session) session.consumed = true;
}
function publicSession(session: Session) {
  return { config_revision: session.config_revision, id: session.id, challenge: session.challenge, expires_at: session.expires_at, candidates: session.candidates.map(item => ({ ...item })), consumed: session.consumed };
}
