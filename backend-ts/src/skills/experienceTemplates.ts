import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiMemoryItem } from "../db/repositories/pi/memoryItems.ts";
import { listPiMemoryHistory } from "../db/repositories/pi/memoryHistory.ts";
import { parseMemoryExperience, type MemoryExperience } from "../pi/memoryExperience.ts";
import { memoryEvidenceRejection } from "../pi/memoryEvidence.ts";
import { containsSensitiveMemoryContent, transientStatusSnapshot } from "../pi/memoryPolicy.ts";
import { executeSafePiAction, type PiActionContext } from "../pi/actionEngine.ts";
import { scopedRunnerChatActionContext } from "../pi/runnerChatAuthorization.ts";
import { changeManagedSkill, installManagedSkill } from "./managedStore.ts";
import { publicManagedSkill, requireManagedSkill, verifyLibrarySkill } from "./libraryService.ts";
import { EXPERIENCE_TEMPLATE_MARKER } from "./experienceTemplateFormat.ts";
import { SkillLibraryError, skillID } from "./managedTypes.ts";

export type ExperienceTemplateInput = {
  id: string; project_id: string; memory_id: string; expected_memory_revision: number;
};
export type ExperienceTemplateChoice = ExperienceTemplateInput & {
  template_revision: string; choice: "save" | "save_and_enable"; key?: string; expected_revision?: string;
};

// Pi 选择值得提炼的经验；Host 只核实稳定版本、独立验证、归属和安全边界。
export function createExperienceTemplateDraft(db: RunnerDatabase, input: ExperienceTemplateInput) {
  skillID(input.id);
  const memory = getPiMemoryItem(db, input.memory_id);
  if (!memory || memory.scope !== "project" || memory.scope_id !== input.project_id) throw new SkillLibraryError(403, "经验不属于指定项目");
  if (memory.disabled) throw new SkillLibraryError(409, "经验已停用");
  if (memory.revision !== input.expected_memory_revision) throw new SkillLibraryError(409, "经验版本已变化，请重新生成草稿");
  if (memory.authority !== "evidence_backed" || !["resolution", "debugging_pattern"].includes(memory.kind) || memory.confidence === "low") {
    throw new SkillLibraryError(400, "模板需要有可信证据支持的稳定经验");
  }
  const current = parseMemoryExperience(memory.content);
  if (!current || current.outcome === "diagnosis_only") throw new SkillLibraryError(400, "模板需要经过验证的解决经验");
  assertSafeExperience(current);
  const rejection = memoryEvidenceRejection(db, input.project_id, current);
  if (rejection) throw new SkillLibraryError(409, `当前经验验证失效：${rejection}`);
  const knowledge = stableKnowledge(current);
  const validations: Array<{ memory_revision: number; work_id: string; run_id: string; refs: string[]; evidence_refs: string[]; method: string; version: string }> = [];
  const works = new Set<string>();
  // 修正、停用或人工编辑后，旧范围的成功不能继续充当新范围的验证。
  for (const entry of listPiMemoryHistory(db, memory.id).reverse().slice(0, 128)) {
    const item = entry.snapshot;
    const experience = parseMemoryExperience(item.content || "");
    if (!experience || item.disabled || item.authority !== "evidence_backed" || item.kind !== memory.kind ||
      item.scope !== "project" || item.scope_id !== input.project_id || stableKnowledge(experience) !== knowledge) break;
    assertSafeExperience(experience);
    if (!works.has(experience.source.work_id) && !memoryEvidenceRejection(db, input.project_id, experience)) {
      works.add(experience.source.work_id);
      validations.push({ memory_revision: entry.revision, ...experience.source,
        evidence_refs: experience.verification.evidence_refs, method: experience.verification.method, version: experience.version });
    }
    if (["correct", "edit", "disable", "enable"].includes(entry.operation)) break;
  }
  if (validations.length < 2) throw new SkillLibraryError(409, "模板需要至少两个不同 Work 的可信通过验证；重复复盘或出现次数不能替代验证");
  validations.reverse();
  const provenance = { schema_version: 1 as const, project_id: input.project_id, memory_id: memory.id,
    memory_revision: memory.revision, validations };
  if (containsSensitiveMemoryContent(JSON.stringify(provenance))) throw new SkillLibraryError(400, "模板来源包含敏感信息");
  const content = [
    "---", `name: ${input.id}`, `description: ${JSON.stringify(`经过多次验证的项目经验模板：${current.applies_when}`)}`,
    `${EXPERIENCE_TEMPLATE_MARKER} ${JSON.stringify(provenance)}`, "---", "",
    "## 输入要求", "- 读取新任务的目标、当前项目、代码或环境版本、输入材料、验收要求和交付目标。",
    "- 从当前任务重新取得工具授权；缺少必要输入或权限时停止对应步骤并说明缺口。", "",
    "## 适用条件", current.applies_when, `已验证环境：${current.version}`, "",
    "## 步骤", "1. 根据新任务输入复现症状，核对适用条件和环境版本。", `2. 检查根因：${current.root_cause}`,
    `3. 在新任务授权范围内应用处理方式：${current.resolution}`, "4. 执行下列验证，记录本次实际结果与未验证边界。", "",
    "## 验证方式", current.verification.method,
    "重新生成新任务的 Evidence；历史验证仅说明来源，不代表新任务已通过。", "",
    "## 交付目标", "交付新任务所要求的修改或产物，以及实际验证命令、结果、来源版本和剩余限制。",
    "需要代码、脚本或依赖变更时交给现有 Coding Provider 的 Work → Run → Evidence → Handoff 路径。", "",
    "## 范围与授权", `仅适用于项目 ${JSON.stringify(input.project_id)}。`,
    "模板只提供说明，不增加工具、委派或外部操作权限。安装目录不可变，输出放在新任务工作区。",
    "来源元数据仅用于追溯；不要恢复历史任务状态、沿用历史授权或操作来源 Work/Run。", ""
  ].join("\n");
  if (Buffer.byteLength(content) > 128 * 1024) throw new SkillLibraryError(400, "模板超过技能正文大小限制");
  return { schema_version: 1 as const, status: "draft" as const, enabled: false as const, scope: "project" as const,
    ...input, template_revision: createHash("sha256").update(content).digest("hex"), provenance, content,
    selection: { endpoint: "/api/pi/skill-library/templates/select", choices: ["save", "save_and_enable"] } };
}

// 仅由用户的 HTTP 选择入口调用；不注册成可由模型自行调用的写工具。
export async function selectExperienceTemplate(db: RunnerDatabase, input: ExperienceTemplateChoice, context: PiActionContext = { source: "runner_chat" }) {
  if (!["save", "save_and_enable"].includes(input.choice)) throw new SkillLibraryError(400, "请选择仅保存或保存并启用");
  if (Boolean(input.key) !== Boolean(input.expected_revision)) throw new SkillLibraryError(400, "更新模板需要 key 和 expected_revision");
  if (input.key && input.choice !== "save") throw new SkillLibraryError(400, "更新保留原启用状态；请通过技能管理单独选择启用");
  const draft = createExperienceTemplateDraft(db, input);
  if (draft.template_revision !== input.template_revision) throw new SkillLibraryError(409, "草稿内容已变化，请重新查看并选择");
  if (input.key) {
    const installed = requireManagedSkill(db, input.key);
    if (installed.id !== input.id || installed.scope !== "project" || installed.project_id !== input.project_id) throw new SkillLibraryError(403, "模板更新不能改变名称或项目范围");
  }
  const actionType = input.key ? "skill.update" : "skill.install";
  return executeSafePiAction(db, scopedRunnerChatActionContext(context, actionType, { projectID: input.project_id }), {
    actionType, projectID: input.project_id,
    payload: { id: input.id, project_id: input.project_id, memory_id: input.memory_id,
      expected_memory_revision: input.expected_memory_revision, template_revision: draft.template_revision,
      choice: input.choice, ...(input.key ? { key: input.key, expected_revision: input.expected_revision } : {}) },
    execute: async () => {
      const source = { kind: "inline" as const, content: draft.content };
      const selection = { experienceTemplateSelection: true };
      const skill = input.key
        ? await changeManagedSkill(dirname(db.path), { key: input.key, expected_revision: input.expected_revision!, operation: "update", source }, selection)
        : await installManagedSkill(dirname(db.path), { id: input.id, scope: "project", project_id: input.project_id, source, enabled: input.choice === "save_and_enable" }, selection);
      return { skill: publicManagedSkill(skill), template_revision: draft.template_revision, provenance: draft.provenance, verification: await verifyLibrarySkill(db, skill.key) };
    }
  });
}

function stableKnowledge(experience: MemoryExperience): string {
  return JSON.stringify([experience.outcome || "verified_resolution", experience.applies_when, experience.symptom,
    experience.root_cause, experience.resolution, experience.failed_attempts, experience.version]);
}

function assertSafeExperience(experience: MemoryExperience): void {
  if (containsSensitiveMemoryContent(JSON.stringify(experience))) throw new SkillLibraryError(400, "经验包含敏感信息，不能生成模板");
  const { source: _source, verification, ...knowledge } = experience;
  const reusableText = JSON.stringify({ ...knowledge, verification: verification.method });
  if (transientStatusSnapshot(reusableText) || /xw:(?:work|run|evidence|handoff):|(?:issue|work|run|任务)\s*#?\d+/i.test(reusableText)) {
    throw new SkillLibraryError(400, "模板不能携带旧任务状态或绑定旧任务输入");
  }
}
