import { SkillLibraryError } from "./managedTypes.ts";

export const EXPERIENCE_TEMPLATE_MARKER = "xuanwu-experience-template:";
export type ExperienceTemplateSelection = { experienceTemplateSelection?: boolean };

export function isExperienceTemplate(content: string): boolean {
  return content.includes(EXPERIENCE_TEMPLATE_MARKER);
}

export function assertExperienceTemplateSelection(options: ExperienceTemplateSelection): void {
  if (options.experienceTemplateSelection !== true) {
    throw new SkillLibraryError(403, "经验模板需要用户明确选择保存或启用；请使用模板选择接口");
  }
}

export function assertExperienceTemplateScope(content: string, scope: string, projectID: string): void {
  if (!isExperienceTemplate(content)) return;
  let provenance;
  try { provenance = JSON.parse(content.match(/^xuanwu-experience-template: (.+)$/m)?.[1] || ""); }
  catch { throw new SkillLibraryError(400, "经验模板来源格式无效"); }
  if (!provenance || provenance.schema_version !== 1 || scope !== "project" || provenance.project_id !== projectID) {
    throw new SkillLibraryError(403, "经验模板不能扩张原项目范围");
  }
}
