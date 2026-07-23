import type { Database as SQLiteDatabase } from "bun:sqlite";

export const DEFAULT_PI_AGENT_ID = "runner-default";
export const DEFAULT_PI_AGENT_NAME = "Xuanwu Supervisor";

const DEFAULT_PI_AGENT_INSTRUCTIONS = "你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。";

type PiAgentBootstrapDatabase = {
  readonly: boolean;
  sqlite: SQLiteDatabase;
};

type PiAgentSeed = {
  cwd_policy: string;
  enabled: number;
  instructions: string;
  model_id: string;
  model_provider: string;
  name: string;
  provider: string;
  thinking_level: string;
  tools_json: string;
};

export function ensureDefaultPiAgent(db: PiAgentBootstrapDatabase): void {
  if (db.readonly) return;
  if (hasRunnerDefault(db.sqlite)) return;
  const timestamp = new Date().toISOString();
  const seed = legacyPiAgentSeed(db.sqlite) ?? builtInPiAgentSeed();
  db.sqlite.run(
    `insert into pi_agents (
      id, name, provider, model_provider, model_id, thinking_level,
      cwd_policy, tools_json, instructions, enabled, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULT_PI_AGENT_ID,
      seed.name,
      seed.provider,
      seed.model_provider,
      seed.model_id,
      seed.thinking_level,
      seed.cwd_policy,
      seed.tools_json,
      seed.instructions,
      seed.enabled,
      timestamp,
      timestamp
    ]
  );
  collapseLegacyPiAgents(db.sqlite);
  normalizeLegacySupervisorDefaults(db.sqlite);
}

function collapseLegacyPiAgents(sqlite: SQLiteDatabase): void {
  sqlite.run("update project_pi_settings set pi_agent_id=? where pi_agent_id<>?", [DEFAULT_PI_AGENT_ID, DEFAULT_PI_AGENT_ID]);
  sqlite.run("update pi_conversations set pi_agent_id=? where pi_agent_id<>?", [DEFAULT_PI_AGENT_ID, DEFAULT_PI_AGENT_ID]);
  sqlite.run("delete from pi_agents where id<>?", [DEFAULT_PI_AGENT_ID]);
}

function normalizeLegacySupervisorDefaults(sqlite: SQLiteDatabase): void {
  sqlite.run(
    `update pi_agents set name=?, updated_at=?
      where id=? and name in ('PI Assistant', 'Runner Agent', 'Runner Brain')`,
    [DEFAULT_PI_AGENT_NAME, new Date().toISOString(), DEFAULT_PI_AGENT_ID]
  );
  sqlite.run(
    `update pi_agents set instructions=?, updated_at=?
      where id=? and instructions in (
        '你是玄武的 Supervisor runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀工程记忆。',
        '你是全局 PI Assistant runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
        '你是全局 Runner Agent，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',
        '你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。'
      )`,
    [DEFAULT_PI_AGENT_INSTRUCTIONS, new Date().toISOString(), DEFAULT_PI_AGENT_ID]
  );
}

function hasRunnerDefault(sqlite: SQLiteDatabase): boolean {
  const row = sqlite.query<{ count: number }, [string]>("select count(*) as count from pi_agents where id=?").get(DEFAULT_PI_AGENT_ID);
  return Number(row?.count ?? 0) > 0;
}

function legacyPiAgentSeed(sqlite: SQLiteDatabase): PiAgentSeed | null {
  return sqlite.query<PiAgentSeed, []>(
    `select name, provider, model_provider, model_id, thinking_level,
      cwd_policy, tools_json, instructions, enabled
     from pi_agents
     order by enabled desc, created_at asc, id asc
     limit 1`
  ).get() ?? null;
}

function builtInPiAgentSeed(): PiAgentSeed {
  return {
    cwd_policy: "project",
    enabled: 1,
    instructions: DEFAULT_PI_AGENT_INSTRUCTIONS,
    model_id: "gpt-5.4",
    model_provider: "openai",
    name: DEFAULT_PI_AGENT_NAME,
    provider: "pi-sdk",
    thinking_level: "medium",
    tools_json: "[]"
  };
}
