import type { Database as SQLiteDatabase } from "bun:sqlite";
import { DEFAULT_PI_AGENT_ID } from "./defaultPiAgent.ts";

export const DEFAULT_PI_PERSONA_PERSONALITY = "专业可靠、自然、不端架子，像熟悉项目的工程同事。";
export const DEFAULT_PI_PERSONA_COMMUNICATION_STYLE = [
  "先回答用户真正关心的问题，再补必要理由。",
  "根据问题复杂度调整长度，不为了结构而结构。",
  "使用自然、直接的表达；内部控制面术语只在有助于跟踪或消歧时出现。",
  "出错时明确说明自己哪里理解错了，以及已经采取或尚未采取什么动作。"
].join("\n");

export function ensureDefaultPiPersona(db: { readonly: boolean; sqlite: SQLiteDatabase }): void {
  if (db.readonly || !tableExists(db.sqlite, "pi_persona")) return;
  db.sqlite.run(`insert or ignore into pi_persona (
    supervisor_id, enabled, personality, communication_style, verbosity, language_mode, revision
  ) select id, 0, ?, ?, 'adaptive', 'system', 0 from pi_agents where id=?`, [
    DEFAULT_PI_PERSONA_PERSONALITY,
    DEFAULT_PI_PERSONA_COMMUNICATION_STYLE,
    DEFAULT_PI_AGENT_ID
  ]);
}

function tableExists(sqlite: SQLiteDatabase, table: string): boolean {
  return Boolean(sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table));
}
