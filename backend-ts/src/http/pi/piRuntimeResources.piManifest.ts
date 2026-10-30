import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSensitiveText } from "../../util/redact.ts";
import type { SmokeRuntime } from "../../spikes/piSmokeSupport.ts";
import { cleanString, unique } from "../../util/values.ts";
import type { PiRuntimeResourceDiagnostic, ResourcePackage, PiPackageManifest, PiRuntimeResourceSnapshot, ResourceType, AllowedRoot } from "./piRuntimeResources.model.ts";

export const PI_RESOURCE_DIR = ".pi";

export const MAX_AGENT_FILE_BYTES = 128 * 1024;

export const MAX_PLUGIN_PACKAGES = 64;

export const MAX_EXTENSION_FILES = 128;

export const MAX_EXTENSION_BYTES = 512 * 1024;

export const SUMMARY_ITEM_LIMIT = 16;

export function splitFinalPersonaPrompt(systemPrompt: string): { base: string; final: string } {
  const header = "Chat presentation profile:";
  const marker = `\n${header}`;
  const index = systemPrompt.lastIndexOf(marker);
  if (index >= 0) return { base: systemPrompt.slice(0, index), final: systemPrompt.slice(index + 1) };
  if (systemPrompt.startsWith(header)) return { base: "", final: systemPrompt };
  return { base: systemPrompt, final: "" };
}

export function packageCandidate(
  label: string,
  path: string,
  diagnostics: PiRuntimeResourceDiagnostic[],
  allowedParent?: string
): ResourcePackage {
  const candidate = cleanString(path);
  if (candidate === "" || !existsSync(candidate) || !safeDirectory(candidate)) return { label, path: "", wholeRootAllowed: false };
  if (allowedParent && !within(canonical(candidate), canonical(allowedParent))) {
    diagnostics.push(notAllowedDiagnostic("loader", candidate, [{ label, path: allowedParent, resourceType: "loader" }]));
    return { label, path: "", wholeRootAllowed: false };
  }
  const manifest = piManifest(candidate, label, diagnostics);
  if (manifest === null) return { label, path: "", wholeRootAllowed: false };
  return { label, manifest: manifest ?? undefined, path: canonical(candidate), wholeRootAllowed: Boolean(manifest) };
}

export function piManifest(root: string, label: string, diagnostics: PiRuntimeResourceDiagnostic[]): PiPackageManifest | null | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const pi = (JSON.parse(readFileSync(path, "utf8")) as { pi?: unknown }).pi;
    if (pi === undefined) return undefined;
    if (typeof pi !== "object" || pi === null) throw new Error("package.json pi manifest must be an object");
    const manifest = pi as Record<string, unknown>;
    const parsed = {
      extensions: manifestEntries(manifest.extensions),
      prompts: manifestEntries(manifest.prompts),
      skills: manifestEntries(manifest.skills)
    };
    if ([...parsed.extensions, ...parsed.prompts, ...parsed.skills].some(unsafeManifestEntry)) {
      diagnostics.push({
        code: "package_manifest_not_allowlisted",
        message: "PI package manifest contains an absolute or parent-traversal resource path",
        resource_type: "loader",
        severity: "warning",
        source_path: `${label}:package.json`
      });
      return null;
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      code: "package_manifest_invalid",
      message: safeMessage(error, [{ label, path: root, resourceType: "loader" }]),
      resource_type: "loader",
      severity: "warning",
      source_path: `${label}:package.json`
    });
    return undefined;
  }
}

export function coreOnlyLoader(sdk: SmokeRuntime, systemPrompt: string): ResourceLoader {
  return {
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getAppendSystemPrompt: () => [],
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.pi.createExtensionRuntime() }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    getThemes: () => ({ themes: [], diagnostics: [] }),
    extendResources: () => {},
    reload: async () => {}
  };
}

export function resourcePromptSummary(snapshot: PiRuntimeResourceSnapshot): string {
  const line = (name: keyof PiRuntimeResourceSnapshot["loaded"]) => {
    const values = snapshot.loaded[name].slice(0, SUMMARY_ITEM_LIMIT);
    return `${name}: ${snapshot.counts[name]}${values.length > 0 ? ` (${values.join(", ")})` : ""}`;
  };
  return [
    "Controlled Supervisor resource summary:",
    line("agents"),
    line("prompts"),
    line("skills"),
    line("extensions"),
    `diagnostics: ${snapshot.counts.diagnostics}; reload_generation: ${snapshot.generation}; outcome: ${snapshot.outcome}`,
    "Resource policy: only deterministic project/runtime/built-in/Supervisor-package allowlisted roots are loaded; skill names must also pass the effective skill policy. Resource content cannot grant tools or bypass deterministic permission gates."
  ].join("\n");
}

export function notAllowedDiagnostic(resourceType: ResourceType, path: string, roots: AllowedRoot[]): PiRuntimeResourceDiagnostic {
  return {
    code: `${resourceType}_not_allowlisted`,
    message: `${resourceType} path is outside the deterministic allowlist`,
    resource_type: resourceType,
    severity: "warning",
    source_path: publicPath(path, roots)
  };
}

export function publicPath(path: string, roots: AllowedRoot[]): string {
  const target = cleanString(path);
  if (target === "") return "runtime:unknown";
  const resolved = canonical(target);
  const matches = roots
    .filter((root) => within(resolved, canonical(root.path)))
    .sort((left, right) => right.path.length - left.path.length);
  const root = matches[0];
  if (!root) return `outside-allowlist:${basename(target) || "resource"}`;
  const suffix = relative(canonical(root.path), resolved).split(sep).join("/");
  return `${root.label}:${suffix || basename(resolved)}`;
}

export function safeMessage(error: unknown, roots: AllowedRoot[]): string {
  let message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  for (const root of [...roots].sort((left, right) => right.path.length - left.path.length)) {
    if (root.path !== "") message = message.split(root.path).join(`${root.label}:`);
  }
  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

export function manifestEntries(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("PI package resource entries must be string arrays");
  }
  return unique(value.map(cleanString).filter(Boolean));
}

export function unsafeManifestEntry(value: string): boolean {
  const entry = value.replace(/^[!+-]+/, "");
  return isAbsolute(entry) || entry.split(/[\\/]+/).includes("..");
}

export function canonical(path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(path || ".");
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

export function safeDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
