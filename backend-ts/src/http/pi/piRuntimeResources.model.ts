import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

export type PiRuntimeResourceDiagnostic = {
  code: string;
  message: string;
  resource_type: "agent" | "extension" | "loader" | "prompt" | "skill";
  severity: "warning" | "error";
  source_path: string;
};

export type PiRuntimeResourceSnapshot = {
  counts: { agents: number; diagnostics: number; extensions: number; prompts: number; skills: number };
  diagnostics: PiRuntimeResourceDiagnostic[];
  generation: number;
  loaded: { agents: string[]; extensions: string[]; prompts: string[]; skills: string[] };
  outcome: "loaded" | "fallback";
  sources: string[];
};

export type ControlledPiResourceOptions = {
  agentDir: string;
  allowedSkillIDs: string[];
  cwd: string;
  onSnapshot?: (snapshot: PiRuntimeResourceSnapshot) => void;
  piPackageDir?: string;
  runtimeRoot: string;
  resourceScope?: "core" | "full";
  systemPrompt: string;
  skillPaths?: string[];
  skillLoadDiagnostics?: PiRuntimeResourceDiagnostic[];
};

export type ResourceType = PiRuntimeResourceDiagnostic["resource_type"];

export type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];

export type ResourcePathEntry = NonNullable<ResourceExtensionPaths["skillPaths"]>[number];

export type PiPackageManifest = { extensions: string[]; prompts: string[]; skills: string[] };

export type ResourcePackage = { label: string; manifest?: PiPackageManifest; path: string; wholeRootAllowed: boolean };

export type AllowedRoot = { label: string; path: string; resourceType: ResourceType };

export type Discovery = {
  agents: Array<{ content: string; path: string }>;
  allowedRoots: AllowedRoot[];
  diagnostics: PiRuntimeResourceDiagnostic[];
  extensionPaths: string[];
  packages: ResourcePackage[];
  promptPaths: string[];
  skillPaths: string[];
};
