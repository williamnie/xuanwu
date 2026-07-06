import type { RunnerDatabase } from "../db/database.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { resolveFeishuProjectContext } from "./feishuProjectContext.ts";
import type { FeishuConversationRoute } from "./feishuConversationRouting.ts";

export type FeishuProjectSwitchStatus = "none" | "resolved" | "missing" | "ambiguous";
export type FeishuProjectSwitchResult = {
  candidates: string[];
  projectId: string;
  reason: string;
  status: FeishuProjectSwitchStatus;
  target: string;
  text: string;
};

const PROJECT_SWITCH_PATTERNS = [
  /^\/p\s+([\s\S]+)$/i,
  /^\/project\s+([\s\S]+)$/i,
  /^项目\s+([\s\S]+)$/,
  /^切到\s+([\s\S]+)$/
] as const;

export function applyFeishuProjectSwitchCommand(
  db: RunnerDatabase,
  input: { route: FeishuConversationRoute; timestamp?: Date; text: string }
): FeishuProjectSwitchResult {
  const target = parseFeishuProjectSwitchTarget(input.text);
  if (target === "") return switchResult("none", "", [], "", "");
  const context = resolveFeishuProjectContext({
    projects: listProjects(db).map((project) => ({ id: project.id, name: project.name })),
    text: target
  });
  if (context.status === "resolved") {
    return switchResult("resolved", context.projectId, context.candidates, "project_switch_sent", switchConfirmText(context.projectId), target);
  }
  if (context.status === "ambiguous") {
    return switchResult("ambiguous", "", context.candidates, "project_switch_ambiguous", switchAmbiguousText(context.candidates), target);
  }
  return switchResult("missing", "", [], "project_switch_missing", switchMissingText(target), target);
}

export function parseFeishuProjectSwitchTarget(text: string): string {
  const body = cleanString(text);
  for (const pattern of PROJECT_SWITCH_PATTERNS) {
    const target = cleanString(body.match(pattern)?.[1]);
    if (target !== "") return target;
  }
  return "";
}

function switchConfirmText(projectId: string): string {
  return `已识别 ${projectId}。IM 通道不会保存当前项目；请把项目名或 issue id 写在具体请求里。`;
}

function switchMissingText(target: string): string {
  return `没找到项目 ${target}，请换项目名或用项目列表选择。`;
}

function switchAmbiguousText(candidates: string[]): string {
  return `找到多个项目：${candidates.join("、")}。请说得更精确一点，后续 issue 会用卡片选择解决。`;
}

function switchResult(
  status: FeishuProjectSwitchStatus,
  projectId: string,
  candidates: string[],
  reason: string,
  text: string,
  target = ""
): FeishuProjectSwitchResult {
  return { candidates, projectId, reason, status, target, text };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
