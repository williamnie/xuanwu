import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listBrowserAssistantTools } from "../pi/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/httpToolProvider.ts";
import { validateWorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  INVESTIGATE_STAGE_IDS,
  INVESTIGATE_VERIFICATION_POLICY,
  INVESTIGATE_WORKFLOW_MANIFEST,
  INVESTIGATE_WORKFLOW_REF,
  investigateWorkflowRegistryContributions
} from "./investigate.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");

describe("Investigate Workflow", () => {
  test("registers and resolves the exact canonical read-only revision", () => {
    const fixtureManifest = JSON.parse(readFileSync(resolve(FIXTURES, "investigate-workflow-v1.json"), "utf8"));
    expect(fixtureManifest).toEqual(INVESTIGATE_WORKFLOW_MANIFEST);
    expect(validateWorkflowManifest(INVESTIGATE_WORKFLOW_MANIFEST)).toEqual({ issues: [], ok: true });
    expect(validateWorkflowVerificationPolicy(INVESTIGATE_VERIFICATION_POLICY)).toEqual({ errors: [], ok: true });

    const registry = investigateRegistry();

    expect(registry.diagnostics).toEqual([]);
    expect(registry.resolve(INVESTIGATE_WORKFLOW_REF)).toMatchObject({
      ok: true,
      resolution: { manifest: { id: "workflow:investigate", revision: 1 } }
    });
  });

  test("fails closed when a catalog widens any allowed tool beyond read permission", () => {
    expect(INVESTIGATE_WORKFLOW_MANIFEST.stages.map((stage) => stage.id)).toEqual([...INVESTIGATE_STAGE_IDS]);
    for (const stage of INVESTIGATE_WORKFLOW_MANIFEST.stages) {
      expect(stage.permissions.max_tool_permission).toBe("read");
      expect(stage.permissions.allowed_actions).toEqual([]);
      expect(stage.approval).toEqual({ mode: "none" });
    }

    const tools = investigateTools().map((tool) =>
      tool.name === "repo_search" ? { ...tool, permission: "write" as const } : tool
    );
    const contributions = investigateWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: [],
      manifests: contributions.manifests,
      skills: [],
      tools,
      verification_policies: contributions.verification_policies
    });

    expect(registry.diagnostics).toContainEqual(expect.objectContaining({
      code: "permission_conflict",
      message: "tool runner-builtin:repo_search requires write"
    }));
    expect(registry.resolve(INVESTIGATE_WORKFLOW_REF)).toMatchObject({ ok: false });
  });
});

function investigateRegistry() {
  const contributions = investigateWorkflowRegistryContributions();
  return createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: [],
    manifests: contributions.manifests,
    skills: [],
    tools: investigateTools(),
    verification_policies: contributions.verification_policies
  });
}

function investigateTools() {
  return [
    ...listBuiltinAssistantTools(),
    ...listHttpAssistantTools(),
    ...listBrowserAssistantTools()
  ];
}
