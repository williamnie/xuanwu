import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { cleanString, unique } from "../../util/values.ts";
import type { ControlledPiResourceOptions, PiRuntimeResourceDiagnostic, ResourcePackage, AllowedRoot, ResourceType } from "./piRuntimeResources.model.ts";
import { PI_RESOURCE_DIR, safeDirectory, MAX_PLUGIN_PACKAGES, packageCandidate, safeMessage, within, canonical, notAllowedDiagnostic, MAX_EXTENSION_FILES, publicPath, MAX_EXTENSION_BYTES } from "./piRuntimeResources.piManifest.ts";

export function pluginCandidates(options: ControlledPiResourceOptions, diagnostics: PiRuntimeResourceDiagnostic[]): ResourcePackage[] {
  const roots = unique([
    join(options.runtimeRoot, "plugins"),
    join(options.cwd, PI_RESOURCE_DIR, "plugins"),
    join(options.agentDir, "plugins"),
    cleanString(options.piPackageDir) === "" ? "" : join(cleanString(options.piPackageDir), "plugins")
  ]).filter(Boolean);
  const packages: ResourcePackage[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !safeDirectory(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, MAX_PLUGIN_PACKAGES)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const item = packageCandidate(`plugin:${entry.name}`, join(root, entry.name), diagnostics, root);
        if (item.path !== "") packages.push(item);
      }
    } catch (error) {
      diagnostics.push({
        code: "plugin_discovery_failed",
        message: safeMessage(error, [{ label: "plugins", path: root, resourceType: "loader" }]),
        resource_type: "loader",
        severity: "warning",
        source_path: "plugins:root"
      });
    }
  }
  return packages;
}

export function hasResources(source: ResourcePackage): boolean {
  return source.manifest
    ? [...source.manifest.extensions, ...source.manifest.prompts, ...source.manifest.skills].length > 0
    : ["extensions", "prompts", "skills"].some((name) => existsSync(join(source.path, name)));
}

export function packageAllowedRoots(source: ResourcePackage): AllowedRoot[] {
  const roots: AllowedRoot[] = [];
  for (const resourceType of ["extension", "prompt", "skill"] as const) {
    const path = source.wholeRootAllowed ? source.path : join(source.path, `${resourceType}s`);
    if (!source.wholeRootAllowed && !within(canonical(path), canonical(source.path))) continue;
    roots.push({
      label: source.label,
      path,
      resourceType
    });
  }
  return roots;
}

export function packagePaths(
  source: ResourcePackage,
  resourceType: "extension" | "prompt" | "skill",
  diagnostics: PiRuntimeResourceDiagnostic[]
): string[] {
  if (!source.manifest) {
    const path = join(source.path, `${resourceType}s`);
    if (!existsSync(path)) return [];
    if (within(canonical(path), canonical(source.path))) return [path];
    diagnostics.push(notAllowedDiagnostic(resourceType, path, [{ label: source.label, path: source.path, resourceType }]));
    return [];
  }
  const entries = source.manifest[`${resourceType}s`];
  return entries
    .filter((entry) => !/^[!+-]/.test(entry))
    .flatMap((entry) => expandManifestEntry(source, entry, resourceType, diagnostics));
}

export function expandManifestEntry(
  source: ResourcePackage,
  entry: string,
  resourceType: "extension" | "prompt" | "skill",
  diagnostics: PiRuntimeResourceDiagnostic[]
): string[] {
  try {
    const matches = hasGlob(entry)
      ? [...new Bun.Glob(entry).scanSync({ absolute: true, cwd: source.path, onlyFiles: false })]
      : [resolve(source.path, entry)];
    return matches.filter((path) => {
      if (within(canonical(path), canonical(source.path))) return true;
      diagnostics.push(notAllowedDiagnostic(resourceType, path, packageAllowedRoots(source)));
      return false;
    });
  } catch (error) {
    diagnostics.push({
      code: "package_manifest_entry_invalid",
      message: safeMessage(error, packageAllowedRoots(source)),
      resource_type: resourceType,
      severity: "warning",
      source_path: `${source.label}:package.json`
    });
    return [];
  }
}

export function extensionFiles(
  path: string,
  roots: AllowedRoot[],
  diagnostics: PiRuntimeResourceDiagnostic[],
  depth = 0
): string[] {
  if (depth > 6 || !existsSync(path)) return [];
  const resolved = canonical(path);
  if (!pathAllowed(resolved, "extension", roots)) {
    diagnostics.push(notAllowedDiagnostic("extension", path, roots));
    return [];
  }
  let stat;
  try { stat = statSync(resolved); } catch { return []; }
  if (stat.isFile()) return validExtensionFile(resolved, stat.size, roots, diagnostics) ? [resolved] : [];
  if (!stat.isDirectory()) return [];
  try {
    return readdirSync(resolved, { withFileTypes: true })
      .slice(0, MAX_EXTENSION_FILES)
      .flatMap((entry) => extensionFiles(join(resolved, entry.name), roots, diagnostics, depth + 1));
  } catch (error) {
    diagnostics.push({
      code: "extension_discovery_failed",
      message: safeMessage(error, roots),
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(resolved, roots)
    });
    return [];
  }
}

export function validExtensionFile(
  path: string,
  size: number,
  roots: AllowedRoot[],
  diagnostics: PiRuntimeResourceDiagnostic[]
): boolean {
  const extension = extname(path).toLowerCase();
  if (![".cjs", ".js", ".mjs", ".ts"].includes(extension)) return false;
  if (size > MAX_EXTENSION_BYTES) {
    diagnostics.push({
      code: "extension_too_large",
      message: "Extension exceeds the runtime size limit",
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(path, roots)
    });
    return false;
  }
  try {
    const loader = extension === ".ts" ? "ts" : "js";
    new Bun.Transpiler({ loader }).transformSync(readFileSync(path, "utf8"));
    return true;
  } catch (error) {
    diagnostics.push({
      code: "extension_parse_failed",
      message: safeMessage(error, roots),
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(path, roots)
    });
    return false;
  }
}

export function pathAllowed(path: string, resourceType: ResourceType, roots: AllowedRoot[]): boolean {
  const target = canonical(path);
  return roots.some((root) => root.resourceType === resourceType && within(target, canonical(root.path)));
}

export function hasGlob(value: string): boolean {
  return /[*?{}[\]]/.test(value);
}

export function dedupePackages(values: ResourcePackage[]): ResourcePackage[] {
  const found = new Map<string, ResourcePackage>();
  for (const value of values) if (!found.has(canonical(value.path))) found.set(canonical(value.path), value);
  return [...found.values()];
}
