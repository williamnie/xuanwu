import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listBrowserAssistantTools } from "../pi/tools/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/tools/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/tools/httpToolProvider.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  MIGRATE_VERIFICATION_POLICY,
  MIGRATE_WORKFLOW_MANIFEST,
  MIGRATE_WORKFLOW_REF,
  RELEASE_VERIFICATION_POLICY,
  RELEASE_WORKFLOW_MANIFEST,
  RELEASE_WORKFLOW_REF,
  RESEARCH_VERIFICATION_POLICY,
  RESEARCH_WORKFLOW_MANIFEST,
  RESEARCH_WORKFLOW_REF,
  longRunningWorkflowRegistryContributions,
  
} from "./releaseResearchMigrate.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0057-release-research-migrate-workflows.md");
const SOURCE_DIGEST = "a".repeat(64);
const TARGET_DIGEST = "b".repeat(64);

describe("Release, Research, and Migrate Workflows", () => {
  test("registers the three exact canonical manifests and their Evidence policies", () => {
    const fixtures = [
      ["release-workflow-v1.json", RELEASE_WORKFLOW_MANIFEST],
      ["research-workflow-v1.json", RESEARCH_WORKFLOW_MANIFEST],
      ["migrate-workflow-v1.json", MIGRATE_WORKFLOW_MANIFEST]
    ] as const;
    for (const [name, manifest] of fixtures) {
      expect(JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"))).toEqual(manifest);
      expect(validateWorkflowManifest(manifest)).toEqual({ issues: [], ok: true });
    }

    const contributions = longRunningWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: ["release.execute", "migration.apply", "work.update"],
      manifests: contributions.manifests,
      skills: [],
      tools: [
        ...listBuiltinAssistantTools(),
        ...listHttpAssistantTools(),
        ...listBrowserAssistantTools()
      ],
      verification_policies: contributions.verification_policies
    });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.items.map((item) => item.ref)).toEqual([
      MIGRATE_WORKFLOW_REF,
      RELEASE_WORKFLOW_REF,
      RESEARCH_WORKFLOW_REF
    ]);
    for (const ref of [RELEASE_WORKFLOW_REF, RESEARCH_WORKFLOW_REF, MIGRATE_WORKFLOW_REF]) {
      expect(registry.resolve(ref)).toMatchObject({ ok: true, resolution: { manifest_ref: ref } });
    }
    expect(RELEASE_VERIFICATION_POLICY.id).toBe("verification-policy:release-readiness");
    expect(RESEARCH_VERIFICATION_POLICY.id).toBe("verification-policy:research-source-evidence");
    expect(MIGRATE_VERIFICATION_POLICY.id).toBe("verification-policy:migrate-contracts");
  });

  test("locks source of truth, compatibility, rollback, and final deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "workflow:release@1",
      "workflow:research@1",
      "workflow:migrate@1",
      "P04 Evidence",
      "P05 Handoff",
      "source repository 是唯一 source of truth",
      "双写：0",
      "双读：仅 bounded validation window",
      "release rollback",
      "最终删除门禁"
    ]) expect(adr).toContain(phrase);
  });
});
