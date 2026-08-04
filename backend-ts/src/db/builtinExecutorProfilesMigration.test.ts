import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { listAgentProfiles } from "./repositories/agentProfiles.ts";

test("seeds selectable Codex and Claude executor profiles idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-builtin-provider-profiles-"));
  try {
    const first = await openDatabase({ stateDir: root });
    expect(listAgentProfiles(first).map((profile) => ({ id: profile.id, provider: profile.provider }))).toEqual([
      { id: "xuanwu-provider-claude", provider: "claude" },
      { id: "xuanwu-provider-codex", provider: "codex" }
    ]);
    first.close();

    const second = await openDatabase({ stateDir: root });
    expect(listAgentProfiles(second)).toHaveLength(2);
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
