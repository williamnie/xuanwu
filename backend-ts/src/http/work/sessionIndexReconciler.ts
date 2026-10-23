import type { RunnerDatabase } from "../../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { cleanString, objectValue } from "../../util/values.ts";

export function reconcileCodexSessionIndexes(db: RunnerDatabase, sessions: Array<Record<string, unknown>>): void {
  for (const session of sessions) {
    reconcileCodexSessionIndex(db, sessionIDFromProviderSession(session), session);
  }
}

export function reconcileCodexSessionIndex(
  db: RunnerDatabase,
  fallbackSessionID: string,
  session: Record<string, unknown>
): void {
  const providerSessionID = firstNonEmpty(sessionIDFromProviderSession(session), fallbackSessionID);
  const status = providerSessionStatus(session);
  if (providerSessionID === "" || status === "") return;
  const existing = getAgentSession(db, `codex:${providerSessionID}`);
  if (!existing || existing.status === status) return;
  upsertAgentSession(db, { provider: "codex", provider_session_id: providerSessionID, status });
}

function sessionIDFromProviderSession(session: Record<string, unknown>): string {
  return firstNonEmpty(
    cleanString(session.provider_session_id),
    cleanString(session.sessionId),
    cleanString(session.thread_id),
    sessionIDFromProviderKey(cleanString(session.id))
  );
}

function providerSessionStatus(session: Record<string, unknown>): string {
  const explicit = sessionStatusText(session.status) || sessionStatusText(session.state);
  if (explicit !== "") return canonicalSessionStatus(explicit);
  return session.isRunning === true ? "running" : "";
}

function sessionStatusText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const raw = objectValue(value);
  return firstNonEmpty(cleanString(raw.type), cleanString(raw.state), cleanString(raw.status));
}

function canonicalSessionStatus(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (["loaded", "notloaded", "not-loaded"].includes(normalized)) return "";
  if (["running", "active", "busy", "streaming"].includes(normalized)) return "running";
  if (["inprogress", "in-progress"].includes(normalized)) return "inProgress";
  if (["completed", "done"].includes(normalized)) return "completed";
  if (["failed", "error", "systemerror", "system-error"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "canceled";
  return value.trim();
}

function sessionIDFromProviderKey(value: string): string {
  return value.startsWith("codex:") ? value.slice("codex:".length).trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}
