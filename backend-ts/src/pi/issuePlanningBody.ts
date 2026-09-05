import { parseIssueDependencyDeclaration } from "../domain/work/issueDependencyDeclaration.ts";

export type IssueBodySection = { heading: string; body: string; level?: number };

// 保留命令块中的 Markdown 文本，避免把验证脚本里的标题当成正文结构。
export function issueBodySections(description: string): IssueBodySection[] {
  const sections: IssueBodySection[] = [{ heading: "", body: "" }];
  let fence = "";
  for (const line of description.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) {
      fence = fence ? "" : marker;
    }
    const heading = !fence && !marker ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : undefined;
    if (heading) sections.push({ heading: heading[2]!, level: heading[1]!.length, body: "" });
    else sections.at(-1)!.body += `${line}\n`;
  }
  return sections.map((section) => ({ ...section, body: section.body.trim() }));
}

export function renderIssueBodySections(sections: IssueBodySection[]): string {
  return sections.map(({ heading, body, level }) => heading ? `${"#".repeat(level ?? 2)} ${heading}\n${body}` : body)
    .filter(Boolean).join("\n\n");
}

export function withIssueBodyDependencies(description: string, ids: number[]): string {
  const declaration = parseIssueDependencyDeclaration(description);
  if (declaration.error) throw new Error(declaration.error);
  const expected = [...ids].sort((a, b) => a - b);
  // 批量创建允许临时“无”，但不能静默丢掉正文里另一个真实前置任务。
  if (declaration.issue_ids.length > 0 && JSON.stringify(declaration.issue_ids) !== JSON.stringify(expected)) {
    throw new Error("正文依赖章节必须与结构化依赖一致");
  }
  const sections = issueBodySections(description);
  const dependencies = sections.filter((section) => /^(依赖|dependencies?)$/i.test(section.heading));
  if (dependencies.length > 1) throw new Error("Issue 正文不能包含多个依赖章节");
  const dependency = dependencies[0] ?? { heading: "依赖", body: "" };
  dependency.body = expected.length ? expected.map((id) => `- Issue #${id}`).join("\n")
    : dependency.heading === "依赖" ? "- 无" : "- None";
  if (!dependencies.length) sections.push(dependency);
  return renderIssueBodySections(sections);
}
