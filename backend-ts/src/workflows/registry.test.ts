import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import {
  WORKFLOW_MANIFEST_SCHEMA_VERSION,
  parseWorkflowManifestJSON,
  validateWorkflowManifest,
  validateWorkflowProjectOverride,
  workflowManifestRef,
  type WorkflowManifest,
  type WorkflowProjectOverride
} from "./manifest.ts";
import { createWorkflowRegistry, type WorkflowRegistryOptions } from "./registry.ts";

const FIXTURES = join(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = join(import.meta.dir, "../../../docs/architecture/xuanwu/0049-workflow-manifest-registry.md");

describe("Workflow Manifest V1", () => {
  test("accepts the legal fixture and publishes an exact revision reference", () => {
    const result = parseWorkflowManifestJSON(fixtureText("workflow-manifest-v1.valid.json"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.manifest).toMatchObject({
      id: "workflow:fixture-implement",
      revision: 1,
      schema_version: WORKFLOW_MANIFEST_SCHEMA_VERSION
    });
    expect(workflowManifestRef(result.manifest)).toBe("workflow:fixture-implement@1");
  });

  test("rejects the illegal fixture with a located unknown-field diagnostic", () => {
    const result = parseWorkflowManifestJSON(fixtureText("workflow-manifest-v1.invalid.json"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid manifest");
    expect(result.issues).toContainEqual({
      code: "unknown_field",
      message: "Unexpected property",
      path: "stages[0].llm_can_bypass_gate"
    });
  });

  test("fails closed on unsupported versions and semantic permission contracts", () => {
    const future = { ...manifest(), schema_version: "xuanwu.workflow-manifest.v2" };
    expect(validateWorkflowManifest(future).issues).toContainEqual({
      code: "unsupported_version",
      message: "must be xuanwu.workflow-manifest.v1",
      path: "schema_version"
    });

    const unsafe = manifest();
    unsafe.stages[0]!.permissions.max_tool_permission = "dangerous";
    unsafe.stages[0]!.approval = { mode: "none" };
    unsafe.stages[0]!.retry = { max_attempts: 3, backoff_seconds: [5] };
    const validation = validateWorkflowManifest(unsafe);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "stages[0].approval.mode",
      "stages[0].retry.backoff_seconds"
    ]));
  });

  test("locks authority, template removal, rollback, and retained workflow boundaries in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");

    expect(adr).toContain("Per-Work authority");
    expect(adr).toContain("双写 0、双读 0");
    expect(adr).toContain("058_drop_issue_templates");
    expect(adr).toContain("回滚");
    expect(adr).toContain("workflow_snapshot_json");
  });
});

describe("Workflow Registry", () => {
  test("keeps revisions exact instead of silently upgrading a Work snapshot", () => {
    const revision1 = manifest();
    const revision2 = { ...manifest(), revision: 2, name: "Fixture implement workflow V2" };
    const registry = createWorkflowRegistry(options([
      { manifest: revision1, source_path: "builtin:fixture/v1.json" },
      { manifest: revision2, source_path: "builtin:fixture/v2.json" }
    ]));

    expect(registry.diagnostics).toEqual([]);
    expect(registry.items.map((item) => item.ref)).toEqual([
      "workflow:fixture-implement@1",
      "workflow:fixture-implement@2"
    ]);
    expect(registry.resolve("workflow:fixture-implement@1")).toMatchObject({
      ok: true,
      resolution: { manifest: { revision: 1 }, manifest_ref: "workflow:fixture-implement@1" }
    });
    expect(registry.resolve("workflow:fixture-implement")).toMatchObject({ ok: false });
    expect(registry.resolve("workflow:fixture-implement@3")).toMatchObject({ ok: false });
  });

  test("resolves an audited project override that can only tighten the base manifest", () => {
    const override = projectOverride();
    const validation = validateWorkflowProjectOverride(override, manifest(), [policy()]);
    expect(validation).toEqual({ issues: [], ok: true });

    const registry = createWorkflowRegistry(options(
      [{ manifest: manifest(), source_path: "builtin:fixture/v1.json" }],
      [{ override, source_path: "project:fixture/.xuanwu/workflow.json" }]
    ));
    const project = registry.resolve("workflow:fixture-implement@1", "fixture-project");
    const otherProject = registry.resolve("workflow:fixture-implement@1", "other-project");

    expect(registry.diagnostics).toEqual([]);
    expect(project).toMatchObject({
      ok: true,
      resolution: {
        manifest: {
          stages: [{
            agent: { profile_id: "fixture-readonly" },
            approval: { mode: "before_stage" },
            permissions: { allowed_actions: [], max_tool_permission: "read" },
            retry: { backoff_seconds: [], max_attempts: 1 }
          }]
        },
        project_override_applied: true,
        project_override_audit_ref: "issue_events:fixture-project:workflow-override:1",
        verification_overrides: [{ deny_manual_override: true }]
      }
    });
    expect(otherProject).toMatchObject({
      ok: true,
      resolution: {
        manifest: { stages: [{ permissions: { allowed_actions: ["work.update"], max_tool_permission: "write" } }] },
        project_override_applied: false
      }
    });
  });

  test("blocks an invalid project override rather than falling back to the wider base", () => {
    const override = projectOverride();
    override.stage_overrides[0]!.permissions = {
      allowed_actions: ["work.update", "release.deploy"],
      allowed_tools: ["runner:work.get"],
      max_tool_permission: "dangerous"
    };
    override.stage_overrides[0]!.retry = { max_attempts: 3 };
    const registry = createWorkflowRegistry(options(
      [{ manifest: manifest(), source_path: "builtin:fixture/v1.json" }],
      [{ override, source_path: "project:fixture/.xuanwu/workflow.json" }]
    ));

    expect(registry.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      "project override cannot increase tool permission",
      "project override cannot increase retry attempts",
      "cannot add release.deploy"
    ]));
    expect(registry.resolve("workflow:fixture-implement@1", "fixture-project")).toMatchObject({ ok: false });
    expect(registry.resolve("workflow:fixture-implement@1", "other-project")).toMatchObject({ ok: true });
  });

  test("diagnoses missing skills, tools, actions, profiles, and policies and refuses resolution", () => {
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: [],
      manifests: [{ manifest: manifest(), source_path: "builtin:fixture/v1.json" }],
      skills: [],
      tools: [],
      verification_policies: []
    });

    expect(registry.items).toMatchObject([{ ready: false }]);
    expect(registry.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "missing_action",
      "missing_agent_profile",
      "missing_skill",
      "missing_tool",
      "missing_verification_policy"
    ]));
    expect(registry.resolve("workflow:fixture-implement@1")).toMatchObject({ ok: false });
  });

  test("quarantines duplicate revisions instead of choosing a source winner", () => {
    const registry = createWorkflowRegistry(options([
      { manifest: manifest(), source_path: "builtin:first.json" },
      { manifest: manifest(), source_path: "plugin:second.json" }
    ]));

    expect(registry.items).toEqual([]);
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate_manifest",
      workflow_ref: "workflow:fixture-implement@1"
    }));
    expect(registry.resolve("workflow:fixture-implement@1")).toMatchObject({ ok: false });
  });
});

function options(
  manifests: WorkflowRegistryOptions["manifests"],
  projectOverrides: WorkflowRegistryOptions["project_overrides"] = []
): WorkflowRegistryOptions {
  return {
    agent_profile_ids: ["fixture-codex", "fixture-readonly"],
    available_actions: ["work.update"],
    manifests,
    project_overrides: projectOverrides,
    skills: [{
      id: "fixture-executor",
      name: "fixture-executor",
      permissions: { max_tool_permission: "read" },
      required_tools: ["runner:work.get"]
    }],
    tools: [{ name: "work.get", permission: "read", provider_id: "runner" }],
    verification_policies: [policy()]
  };
}

function manifest(): WorkflowManifest {
  const result = parseWorkflowManifestJSON(fixtureText("workflow-manifest-v1.valid.json"));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return structuredClone(result.manifest);
}

function projectOverride(): WorkflowProjectOverride {
  return JSON.parse(fixtureText("workflow-project-override-v1.valid.json")) as WorkflowProjectOverride;
}

function policy(): WorkflowVerificationPolicy {
  return {
    schema_version: 1,
    id: "verification-policy:fixture",
    revision: 1,
    name: "Fixture verification policy",
    kind_rules: [],
    required_groups: [{
      id: "fixture-check",
      operator: "all",
      requirements: [{
        id: "fixture-test",
        evidence_kinds: ["test"],
        scope: "work",
        fact_assertions: [],
        artifact_policy: "ignore"
      }]
    }],
    optional_requirements: [],
    risk_overrides: []
  };
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
