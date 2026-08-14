import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { listAgentProfiles } from "./repositories/agentProfiles.ts";
import { migrations } from "./schema/index.ts";

test("seeds selectable code agent profiles idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-builtin-provider-profiles-"));
  try {
    const first = await openDatabase({ stateDir: root });
    expect(listAgentProfiles(first).map((profile) => ({ id: profile.id, provider: profile.provider }))).toEqual([
      { id: "xuanwu-provider-claude", provider: "claude" },
      { id: "xuanwu-provider-codex", provider: "codex" },
      { id: "xuanwu-provider-pi", provider: "pi-coding-agent" },
      { id: "xuanwu-provider-qoder", provider: "qoder" }
    ]);
    expect(listAgentProfiles(first).map((profile) => ({ id: profile.id, sandbox: profile.sandbox }))).toEqual([
      { id: "xuanwu-provider-claude", sandbox: "" },
      { id: "xuanwu-provider-codex", sandbox: "" },
      { id: "xuanwu-provider-pi", sandbox: "" },
      { id: "xuanwu-provider-qoder", sandbox: "" }
    ]);
    first.close();

    const second = await openDatabase({ stateDir: root });
    expect(listAgentProfiles(second)).toHaveLength(4);
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds execution policy storage without mutating inherited built-in profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-builtin-provider-sandbox-upgrade-"));
  const path = join(root, "runner.db");
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    runMigrations(sqlite, migrations.filter((migration) => (
      migration.id !== "069_builtin_pi_executor_profile" &&
      migration.id !== "078_builtin_qoder_executor_profile" &&
      migration.id !== "080_execution_policy_json"
    )));
    const timestamp = "2026-08-12T00:00:00Z";
    const insert = sqlite.query(`insert into agent_profiles (
      id, name, provider, model, reasoning_effort, approval_policy, sandbox,
      service_tier, default_instructions, skill_intents_json, plugin_intents_json,
      created_at, updated_at
    ) values (?, ?, ?, '', '', '', '', '', '', '[]', '[]', ?, ?)`);
    insert.run("xuanwu-provider-pi", "Pi（本机配置）", "pi-coding-agent", timestamp, timestamp);
    insert.run("xuanwu-provider-qoder", "Qoder（本机配置）", "qoder", timestamp, timestamp);

    runMigrations(sqlite);

    expect(sqlite.query<{ execution_policy_json: string; id: string; sandbox: string }, []>(
      "select id, sandbox, execution_policy_json from agent_profiles where id in ('xuanwu-provider-pi', 'xuanwu-provider-qoder') order by id"
    ).all()).toEqual([
      { id: "xuanwu-provider-pi", sandbox: "", execution_policy_json: "{}" },
      { id: "xuanwu-provider-qoder", sandbox: "", execution_policy_json: "{}" }
    ]);
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adds one Qoder profile to an old database without overwriting user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-builtin-qoder-profile-upgrade-"));
  const path = join(root, "runner.db");
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    runMigrations(sqlite, migrations.filter((migration) => migration.id !== "078_builtin_qoder_executor_profile"));
    sqlite.run(`insert into agent_profiles (
      id, name, provider, model, reasoning_effort, approval_policy, sandbox,
      service_tier, default_instructions, skill_intents_json, plugin_intents_json,
      created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      "xuanwu-provider-qoder", "用户自定义 Qoder", "qoder", "performance", "high", "never",
      "read-only", "", "保留用户设置", "[]", "[]", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"
    ]);

    runMigrations(sqlite);
    runMigrations(sqlite);

    expect(sqlite.query<Record<string, unknown>, []>(
      "select id, name, provider, model, reasoning_effort, sandbox, default_instructions from agent_profiles where id='xuanwu-provider-qoder'"
    ).all()).toEqual([{
      id: "xuanwu-provider-qoder",
      name: "用户自定义 Qoder",
      provider: "qoder",
      model: "performance",
      reasoning_effort: "high",
      sandbox: "read-only",
      default_instructions: "保留用户设置"
    }]);
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
