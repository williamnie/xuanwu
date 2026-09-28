export type SkillScope = "instance" | "project";
export type SkillSource = {
  kind: "local" | "git" | "inline";
  location?: string;
  ref?: string;
  subdirectory?: string;
  content?: string;
};
export type SkillRevision = {
  revision: string;
  directory: string;
  digest: string;
  source: SkillSource;
  resolved_ref?: string;
  installed_at: string;
};
export type ManagedSkill = {
  key: string;
  id: string;
  scope: SkillScope;
  project_id: string;
  enabled: boolean;
  revision: string;
  revisions: SkillRevision[];
  cleanup_pending?: boolean;
};
export type SkillCatalog = { version: 1; generation: number; skills: ManagedSkill[] };
export class SkillLibraryError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "SkillLibraryError"; }
}
export function skillID(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw new SkillLibraryError(400, "技能名称须为不超过 64 位的小写字母、数字和连字符");
  }
  return value;
}
