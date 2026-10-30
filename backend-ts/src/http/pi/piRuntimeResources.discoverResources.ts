import type { LoadExtensionsResult, ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JEV_SKILL_ID, jevPackage } from "../../skills/jev/config.ts";
import { cleanString, unique } from "../../util/values.ts";
import type { ControlledPiResourceOptions, Discovery, PiRuntimeResourceDiagnostic, AllowedRoot, ResourcePackage, ResourceType } from "./piRuntimeResources.model.ts";
import { packageCandidate, PI_RESOURCE_DIR, canonical, within, notAllowedDiagnostic, MAX_AGENT_FILE_BYTES, safeMessage, publicPath } from "./piRuntimeResources.piManifest.ts";
import { pluginCandidates, dedupePackages, hasResources, packageAllowedRoots, packagePaths, extensionFiles } from "./piRuntimeResources.validExtensionFile.ts";

export function discoverResources(options: ControlledPiResourceOptions): Discovery {
  const diagnostics: PiRuntimeResourceDiagnostic[] = [...(options.skillLoadDiagnostics ?? [])];
  const optionalPackage = options.allowedSkillIDs.includes(JEV_SKILL_ID) ? jevPackage() : null;
  const optionalPaths = optionalPackage?.installed ? [optionalPackage.directory] : [];
  const optionalRoots: AllowedRoot[] = optionalPaths.map(path => ({ label: "optional-skill", path, resourceType: "skill" }));
  const registeredPaths = options.skillPaths ?? [];
  const registeredRoots: AllowedRoot[] = registeredPaths.map(path => ({ label: "skill-registry", path, resourceType: "skill" }));
  if (options.resourceScope === "core") {
    return {
      agents: [],
      allowedRoots: optionalRoots,
      diagnostics,
      extensionPaths: [],
      packages: [],
      promptPaths: [],
      skillPaths: optionalPaths
    };
  }
  const candidates: ResourcePackage[] = [
    packageCandidate("builtin", options.runtimeRoot, diagnostics),
    packageCandidate("project", join(options.cwd, PI_RESOURCE_DIR), diagnostics, options.cwd),
    packageCandidate("runtime", options.agentDir, diagnostics),
    packageCandidate("pi-package", cleanString(options.piPackageDir), diagnostics),
    ...pluginCandidates(options, diagnostics)
  ].filter((item): item is ResourcePackage => item.path !== "");
  const packages = dedupePackages(candidates).filter(hasResources);
  const allowedRoots = [...packages.flatMap(packageAllowedRoots), ...optionalRoots, ...registeredRoots];
  const skillPaths = options.skillPaths
    ? [...registeredPaths, ...optionalPaths]
    : [...packages.flatMap((source) => packagePaths(source, "skill", diagnostics)), ...optionalPaths];
  const promptPaths = packages.flatMap((source) => packagePaths(source, "prompt", diagnostics));
  const extensionPaths = packages
    .flatMap((source) => packagePaths(source, "extension", diagnostics))
    .flatMap((path) => extensionFiles(path, allowedRoots, diagnostics));
  const agents = [
    readAgentFile("project-agent", join(options.cwd, "AGENTS.md"), options.cwd, diagnostics),
    readAgentFile("runtime-agent", join(options.agentDir, "AGENTS.md"), options.agentDir, diagnostics)
  ].filter((item): item is { content: string; path: string } => Boolean(item));
  allowedRoots.push(
    { label: "project-agent", path: canonical(options.cwd), resourceType: "agent" },
    { label: "runtime-agent", path: canonical(options.agentDir), resourceType: "agent" }
  );
  return {
    agents,
    allowedRoots,
    diagnostics,
    extensionPaths: unique(extensionPaths),
    packages,
    promptPaths: unique(promptPaths),
    skillPaths: unique(skillPaths)
  };
}

export function readAgentFile(
  label: string,
  path: string,
  allowedRoot: string,
  diagnostics: PiRuntimeResourceDiagnostic[]
): { content: string; path: string } | undefined {
  if (!existsSync(path)) return undefined;
  const resolved = canonical(path);
  if (!within(resolved, canonical(allowedRoot))) {
    diagnostics.push(notAllowedDiagnostic("agent", path, [{ label, path: allowedRoot, resourceType: "agent" }]));
    return undefined;
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) {
      diagnostics.push({
        code: "agent_file_invalid",
        message: stat.size > MAX_AGENT_FILE_BYTES ? "AGENTS.md exceeds the runtime size limit" : "AGENTS.md is not a regular file",
        resource_type: "agent",
        severity: "warning",
        source_path: `${label}:AGENTS.md`
      });
      return undefined;
    }
    return { content: readFileSync(resolved, "utf8"), path: resolved };
  } catch (error) {
    diagnostics.push({
      code: "agent_read_failed",
      message: safeMessage(error, [{ label, path: allowedRoot, resourceType: "agent" }]),
      resource_type: "agent",
      severity: "warning",
      source_path: `${label}:AGENTS.md`
    });
    return undefined;
  }
}

export function sanitizeExtensions(
  base: LoadExtensionsResult,
  diagnostics: PiRuntimeResourceDiagnostic[],
  roots: AllowedRoot[]
): LoadExtensionsResult {
  for (const extension of base.extensions) {
    if (extension.tools.size === 0) continue;
    diagnostics.push({
      code: "extension_tools_blocked",
      message: "Extension-registered LLM tools are blocked until they have a deterministic permission adapter",
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(extension.path, roots)
    });
    extension.tools.clear();
  }
  for (const registration of base.runtime.pendingProviderRegistrations) {
    diagnostics.push({
      code: "extension_provider_blocked",
      message: `Extension provider registration ${registration.name} is blocked by the runtime resource policy`,
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(registration.extensionPath, roots)
    });
  }
  base.runtime.pendingProviderRegistrations = [];
  return base;
}

export function resourceDiagnostic(resourceType: "prompt" | "skill", item: ResourceDiagnostic, roots: AllowedRoot[]): PiRuntimeResourceDiagnostic {
  return sdkDiagnostic(`${resourceType}_${item.type}`, resourceType, item.type === "error" ? "error" : "warning", item.path ?? "", item.message, roots);
}

export function sdkDiagnostic(
  code: string,
  resourceType: ResourceType,
  severity: "warning" | "error",
  path: string,
  message: string,
  roots: AllowedRoot[]
): PiRuntimeResourceDiagnostic {
  return {
    code,
    message: safeMessage(message, roots),
    resource_type: resourceType,
    severity,
    source_path: publicPath(path, roots)
  };
}

export function namedPaths(paths: string[], roots: AllowedRoot[]): string[] {
  return sortedNames(paths.map((path) => publicPath(path, roots)));
}

export function sortedNames(values: string[]): string[] {
  return unique(values.map(cleanString).filter(Boolean)).sort();
}

export function sortedDiagnostics(values: PiRuntimeResourceDiagnostic[]): PiRuntimeResourceDiagnostic[] {
  const found = new Map<string, PiRuntimeResourceDiagnostic>();
  for (const value of values) found.set(JSON.stringify(value), value);
  return [...found.values()].sort((left, right) =>
    left.resource_type.localeCompare(right.resource_type) || left.source_path.localeCompare(right.source_path) || left.code.localeCompare(right.code));
}

export function normalizeID(value: string): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}
