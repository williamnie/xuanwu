import type { RunnerDatabase } from "../database.ts";

const LAST_SESSION_PROJECT_KEY = "sessions.last_project_id";

export function lastSessionProject(db: RunnerDatabase): string {
  const row = db.sqlite.query<{ value: unknown }, [string]>(
    "select value from app_preferences where key=?"
  ).get(LAST_SESSION_PROJECT_KEY);
  return typeof row?.value === "string" ? row.value.trim() : "";
}
