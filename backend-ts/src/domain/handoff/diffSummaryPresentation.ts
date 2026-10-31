import { type EvidenceID } from "../evidence/contracts.ts";
import { type HandoffDiffSummary, GENERATED_DIRECTORY_NAMES, GENERATED_BASENAMES } from "./diffSummaryModel.ts";
import { compareText } from "./diffSummaryArtifacts.ts";

export function groupPaths(paths: readonly string[]): HandoffDiffSummary["path_groups"] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    const group = slash < 0 ? "(root)" : path.slice(0, slash);
    const files = groups.get(group) ?? [];
    files.push(path);
    groups.set(group, files);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([group, files]) => ({ group, files: [...files].sort(compareText) }));
}

export function isGeneratedPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1)!;
  if (segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) return true;
  if (GENERATED_BASENAMES.has(basename)) return true;
  return /(?:\.generated\.|\.gen\.|\.g\.dart$|\.freezed\.dart$|\.pb\.(?:go|js|ts)$|_pb2\.py$|\.min\.(?:css|js)$)/.test(basename);
}

export function summaryText(input: {
  binaryFileCount: number;
  changedPathCount: number;
  deletions: number;
  generatedFileCount: number;
  groupCount: number;
  insertions: number;
  largeFileCount: number;
  trackedDiffFileCount: number;
  untrackedFileCount: number | null;
}): string {
  const untracked = input.untrackedFileCount === null
    ? "untracked paths were not observed"
    : `${input.untrackedFileCount} untracked path(s)`;
  return `${input.changedPathCount} changed path(s) across ${input.groupCount} group(s); ` +
    `tracked diff ${input.trackedDiffFileCount} file(s) (+${input.insertions}/-${input.deletions}); ` +
    `${input.binaryFileCount} binary, ${input.largeFileCount} large, ` +
    `${input.generatedFileCount} generated-looking; ${untracked}.`;
}

export function notificationSummaryText(input: {
  binaryFileCount: number;
  changedPathCount: number;
  deletions: number;
  generatedFileCount: number;
  insertions: number;
  largeFileCount: number;
}): string {
  return `${input.changedPathCount} changed path(s); +${input.insertions}/-${input.deletions}; ` +
    `${input.binaryFileCount} binary; ${input.largeFileCount} large; ` +
    `${input.generatedFileCount} generated-looking.`;
}

export function riskHints(
  evidenceID: EvidenceID,
  input: {
    binaryFileCount: number;
    generatedFileCount: number;
    largeFileCount: number;
    legacyDetails: boolean;
  }
): HandoffDiffSummary["risk_hints"] {
  const sourceRefs = [evidenceID];
  const risks: HandoffDiffSummary["risk_hints"] = [];
  if (input.binaryFileCount > 0) risks.push({
    id: "binary_diff",
    severity: "medium",
    summary: `${input.binaryFileCount} binary changed file(s) cannot be reviewed with line diff stats`,
    mitigation: "Review the binary artifact, provenance, and expected checksum separately",
    source_refs: sourceRefs
  });
  if (input.largeFileCount > 0) risks.push({
    id: "large_files",
    severity: "medium",
    summary: `${input.largeFileCount} current worktree file(s) meet the large-file threshold`,
    mitigation: "Confirm repository size policy and use an artifact store when appropriate",
    source_refs: sourceRefs
  });
  if (input.generatedFileCount > 0) risks.push({
    id: "generated_files",
    severity: "low",
    summary: `${input.generatedFileCount} changed path(s) match the generated-file heuristic`,
    mitigation: "Review the source change and verify the documented regeneration command",
    source_refs: sourceRefs
  });
  if (input.legacyDetails) risks.push({
    id: "file_metadata_unavailable",
    severity: "low",
    summary: "Legacy Git Evidence provides paths and aggregate stats without per-file metadata",
    mitigation: "Collect a fresh Git Evidence snapshot before binary-path or large-file review",
    source_refs: sourceRefs
  });
  return risks;
}
