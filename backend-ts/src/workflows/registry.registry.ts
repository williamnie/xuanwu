import { applyWorkflowProjectOverride, parseWorkflowManifestRef, validateWorkflowManifest, validateWorkflowProjectOverride, workflowManifestRef, type WorkflowManifest, type WorkflowProjectOverride, type WorkflowValidationIssue } from "./manifest.ts";
import type { WorkflowRegistryOptions, WorkflowRegistry, WorkflowRegistryDiagnostic, WorkflowRegistryItem, StoredOverride, WorkflowResolutionResult, WorkflowResolution } from "./registry.model.ts";
import { validationDiagnostic, diagnostic, manifestDependencyDiagnostics, overrideTarget, overrideValidationDiagnostic, resolutionFailure, overrideKey } from "./registry.validation.ts";

export function createWorkflowRegistry(options: WorkflowRegistryOptions): WorkflowRegistry {
  const diagnostics: WorkflowRegistryDiagnostic[] = [];
  const entries = new Map<string, WorkflowRegistryItem>();
  const manifestConflicts = new Set<string>();

  for (const registration of options.manifests) {
    const validation = validateWorkflowManifest(registration.manifest);
    if (!validation.ok) {
      diagnostics.push(...validation.issues.map((issue) => validationDiagnostic(issue, registration.source_path)));
      continue;
    }
    const manifest = registration.manifest as WorkflowManifest;
    const ref = workflowManifestRef(manifest);
    if (entries.has(ref) || manifestConflicts.has(ref)) {
      entries.delete(ref);
      manifestConflicts.add(ref);
      diagnostics.push(diagnostic("duplicate_manifest", registration.source_path, "duplicate workflow manifest revision", "$", ref));
      continue;
    }
    const dependencyIssues = manifestDependencyDiagnostics(manifest, registration.source_path, options);
    diagnostics.push(...dependencyIssues);
    entries.set(ref, {
      manifest: structuredClone(manifest),
      ready: dependencyIssues.length === 0,
      ref,
      source_path: registration.source_path
    });
  }

  const overrides = new Map<string, StoredOverride>();
  const blockedOverrides = new Set<string>();
  for (const registration of options.project_overrides ?? []) {
    const target = overrideTarget(registration.override);
    const base = target ? entries.get(target.manifest_ref)?.manifest : undefined;
    const validation = validateWorkflowProjectOverride(
      registration.override,
      base,
      options.verification_policies
    );
    if (!validation.ok || !target || !base) {
      if (target) blockedOverrides.add(target.key);
      const issues = validation.issues.length > 0
        ? validation.issues
        : [{ code: "invalid_value", message: "project override references a missing workflow revision", path: "$" }] as WorkflowValidationIssue[];
      diagnostics.push(...issues.map((issue) => overrideValidationDiagnostic(issue, registration.source_path, target)));
      continue;
    }
    if (overrides.has(target.key) || blockedOverrides.has(target.key)) {
      overrides.delete(target.key);
      blockedOverrides.add(target.key);
      diagnostics.push(diagnostic(
        "duplicate_project_override",
        registration.source_path,
        "duplicate project override for workflow revision",
        "$",
        target.manifest_ref,
        target.project_id
      ));
      continue;
    }
    const effective = applyWorkflowProjectOverride(base, registration.override as WorkflowProjectOverride);
    const dependencyIssues = manifestDependencyDiagnostics(effective, registration.source_path, options, target.project_id);
    if (dependencyIssues.length > 0) {
      blockedOverrides.add(target.key);
      diagnostics.push(...dependencyIssues);
      continue;
    }
    overrides.set(target.key, {
      override: structuredClone(registration.override as WorkflowProjectOverride),
      source_path: registration.source_path
    });
  }

  const items = [...entries.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    diagnostics,
    items,
    resolve: (manifestRef, projectID) => resolveWorkflow(
      manifestRef,
      projectID,
      entries,
      overrides,
      blockedOverrides,
      diagnostics
    )
  };
}

export function resolveWorkflow(
  manifestRef: string,
  projectID: string | undefined,
  entries: ReadonlyMap<string, WorkflowRegistryItem>,
  overrides: ReadonlyMap<string, StoredOverride>,
  blockedOverrides: ReadonlySet<string>,
  diagnostics: readonly WorkflowRegistryDiagnostic[]
): WorkflowResolutionResult {
  const parsed = parseWorkflowManifestRef(manifestRef);
  if (!parsed) return resolutionFailure("invalid_manifest", "workflow ref is invalid", manifestRef, projectID);
  const ref = `${parsed.id}@${parsed.revision}`;
  const entry = entries.get(ref);
  if (!entry) return resolutionFailure("invalid_manifest", "workflow revision is not registered", ref, projectID);
  if (!entry.ready) {
    return {
      diagnostics: diagnostics.filter((item) => item.workflow_ref === ref && item.project_id === undefined),
      ok: false
    };
  }
  const cleanProjectID = projectID?.trim();
  if (!cleanProjectID) return { ok: true, resolution: baseResolution(entry) };
  const key = overrideKey(cleanProjectID, ref);
  if (blockedOverrides.has(key)) {
    const matching = diagnostics.filter((item) => item.workflow_ref === ref && item.project_id === cleanProjectID);
    return matching.length > 0
      ? { diagnostics: matching, ok: false }
      : resolutionFailure("invalid_project_override", "project override is invalid", ref, cleanProjectID);
  }
  const stored = overrides.get(key);
  if (!stored) return { ok: true, resolution: { ...baseResolution(entry), project_id: cleanProjectID } };
  return {
    ok: true,
    resolution: {
      manifest: applyWorkflowProjectOverride(entry.manifest, stored.override),
      manifest_ref: ref,
      project_id: cleanProjectID,
      project_override_applied: true,
      project_override_audit_ref: stored.override.audit_event_ref,
      source_path: entry.source_path,
      verification_overrides: structuredClone(stored.override.verification_overrides)
    }
  };
}

export function baseResolution(entry: WorkflowRegistryItem): WorkflowResolution {
  return {
    manifest: structuredClone(entry.manifest),
    manifest_ref: entry.ref,
    project_override_applied: false,
    source_path: entry.source_path,
    verification_overrides: []
  };
}
