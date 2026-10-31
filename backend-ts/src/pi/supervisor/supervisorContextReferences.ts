import { type Project } from "../../db/repositories/projects.ts";
import { cleanString } from "../../util/values.ts";
import { Candidate, SupervisorContextResolution } from "./supervisorContextSchema.ts";

export function referencedIssueIDs(prompt: string): number[] {
  const ids: number[] = [];
  for (const pattern of [
    /xw:work:issues:([1-9]\d*)/gi,
    /#\s*([1-9]\d*)/g,
    /\b(?:work|issue)\s*(?:#|id\s*[:=]?)?\s*([1-9]\d*)\b/gi,
    /(?:工单|问题|任务)\s*[#号]?\s*([1-9]\d*)/g,
    /(?:^|[^\d])([1-9]\d*)\s*(?:号|中|里|这个\s*issue)/gi
  ]) {
    for (const match of prompt.matchAll(pattern)) {
      const id = Number.parseInt(match[1] ?? "", 10);
      if (Number.isSafeInteger(id) && id > 0) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

export function workIssueID(workID: string): number | undefined {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(workID);
  if (!match) return undefined;
  const id = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function projectTokens(project: Project): string[] {
  return [...new Set([project.id, project.name].map(normalizeForMatch).filter(Boolean))];
}

export function normalizeForMatch(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[\s_-]+/g, "");
}

export function allowsConversationInheritance(source: string): boolean {
  return source === "runner_chat" || source === "runner_review";
}

export function targetBinding(
  candidates: Candidate[],
  projectID: string
): SupervisorContextResolution["provenance"]["target_binding"] {
  if (projectID === "") return "none";
  const candidate = candidates.find((item) => item.project_id === projectID);
  if (!candidate) return "none";
  if (candidate.sources.some((source) => source.kind === "work_reference" || source.kind === "explicit_project")) {
    return "explicit";
  }
  if (candidate.sources.some((source) => source.kind === "one_shot_work" || source.kind === "one_shot_target")) {
    return "one_shot";
  }
  return "conversation";
}

export function positiveInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
