import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { createAgentProfile, updateAgentProfile } from "./repositories/agentProfiles.ts";
import { createProject, getProject, updateProject } from "./repositories/projects.ts";
import { useDatabaseCleanup } from "../testing/harness.ts";

const trackDatabase = useDatabaseCleanup();

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("execution policy persistence compatibility", () => {
  test("new projects default to explicit unattended host access and dual-write legacy fields", async () => {
    const root = await fixtureRoot();
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    const project = createProject(db, { cwd: root, id: "default-policy", name: "Default policy" });
    expect(project.execution_policy).toEqual({
      contract: "xw.execution-policy.v1",
      access: "unrestricted-host",
      approval: "unattended"
    });
    expect(project).toMatchObject({ approval_policy: "never", sandbox: "danger-full-access" });
    expect(JSON.parse(project.execution_policy_json)).toEqual(project.execution_policy);
  });

  test("empty profile policy inherits while explicit and legacy writes remain round-trippable", async () => {
    const root = await fixtureRoot();
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    const inherited = createAgentProfile(db, { id: "inherit", name: "Inherit", provider: "codex" });
    expect(inherited).toMatchObject({ execution_policy_json: "{}", execution_policy_source: "inherit" });
    expect(inherited.execution_policy).toBeUndefined();

    const explicit = updateAgentProfile(db, "inherit", {
      execution_policy: {
        contract: "xw.execution-policy.v1",
        access: "read-only",
        approval: "unattended"
      }
    });
    expect(explicit).toMatchObject({ approval_policy: "never", sandbox: "read-only", execution_policy_source: "profile" });

    const legacy = updateAgentProfile(db, "inherit", { approval_policy: "always", sandbox: "workspace-write" });
    expect(legacy.execution_policy).toEqual({
      contract: "xw.execution-policy.v1",
      access: "provider-native-development",
      approval: "ask-every-side-effect"
    });
    expect(JSON.parse(legacy.execution_policy_json)).toEqual(legacy.execution_policy);
  });

  test("legacy project writes dual-write JSON and unknown stored legacy values fail safe on read", async () => {
    const root = await fixtureRoot();
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    createProject(db, { cwd: root, id: "legacy-policy", name: "Legacy policy" });
    const updated = updateProject(db, "legacy-policy", { approval_policy: "danger-only", sandbox: "workspace-write" });
    expect(updated.execution_policy).toEqual({
      contract: "xw.execution-policy.v1",
      access: "provider-native-development",
      approval: "ask-sensitive"
    });
    expect(JSON.parse(updated.execution_policy_json)).toEqual(updated.execution_policy);

    db.sqlite.run("update projects set execution_policy_json='{}', sandbox='future-sandbox' where id='legacy-policy'");
    const safe = getProject(db, "legacy-policy")!;
    expect(safe.execution_policy.access).toBe("read-only");
    expect(safe.execution_policy_warnings).toContain("legacy_policy_unknown:sandbox");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-policy-persistence-"));
  roots.push(root);
  return root;
}
