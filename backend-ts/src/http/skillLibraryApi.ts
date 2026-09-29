import { Value } from "typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createSkillLibraryTools, experienceTemplateSchema } from "../pi/skillLibraryTools.ts";
import { Type } from "@earendil-works/pi-ai";
import { selectExperienceTemplate } from "../skills/experienceTemplates.ts";
import { libraryProject, listSkillLibrary, publicManagedSkill, requireManagedSkill, verifyLibrarySkill } from "../skills/libraryService.ts";
import { validateManagedSkill } from "../skills/managedStore.ts";
import { dirname } from "node:path";
import { SkillLibraryError } from "../skills/managedTypes.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

export function registerSkillLibraryRoutes(router: Router, db: RunnerDatabase): void {
  router.get("/api/pi/skill-library", request => response(() => listSkillLibrary(db, new URL(request.url).searchParams.get("project_id") || undefined)));
  router.get("/api/pi/skill-library/:key", request => response(async () => {
    const key = new URL(request.url).pathname.split("/").at(-1)!;
    const skill = requireManagedSkill(db, key);
    const validated = await validateManagedSkill(dirname(db.path), skill);
    return { skill: publicManagedSkill(skill), instructions: validated.metadata.instructions, verification: await verifyLibrarySkill(db, key) };
  }));
  const action = (toolName: string) => (request: Request) => response(async () => {
      const body = await parseJsonBody(request);
      const project = libraryProject(db, body && typeof body === "object" && "project_id" in body && typeof body.project_id === "string" ? body.project_id : undefined);
      const definition = createSkillLibraryTools(db, project, { source: "runner_chat" }).find(item => item.name === toolName)!;
      if (!Value.Check(definition.parameters, body)) throw new HttpError(400, "技能请求字段不完整或格式错误");
      return (await definition.execute(`web:${crypto.randomUUID()}`, body as never, undefined, undefined, undefined as never)).details;
    });
  router.post("/api/pi/skill-library/inspect", action("skill_inspect_source"));
  router.post("/api/pi/skill-library/install", action("skill_install"));
  router.post("/api/pi/skill-library/manage", action("skill_manage"));
  router.post("/api/pi/skill-library/verify", action("skill_verify"));
  router.post("/api/pi/skill-library/templates/draft", action("skill_template_draft"));
  router.post("/api/pi/skill-library/templates/select", request => response(async () => {
    const body = await parseJsonBody(request);
    const schema = Type.Object({ ...experienceTemplateSchema.properties,
      template_revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      choice: Type.Union([Type.Literal("save"), Type.Literal("save_and_enable"), Type.Literal("enable"), Type.Literal("rollback")]),
      key: Type.Optional(Type.String({ minLength: 1 })), expected_revision: Type.Optional(Type.String({ minLength: 1 })),
      revision: Type.Optional(Type.String({ minLength: 1 }))
    }, { additionalProperties: false });
    if (!Value.Check(schema, body)) throw new HttpError(400, "请明确选择草稿、版本及保存或启用操作");
    libraryProject(db, body.project_id);
    return selectExperienceTemplate(db, body);
  }));
}

async function response(action: () => unknown): Promise<Response> {
  try { return json(await action()); }
  catch (error) {
    if (error instanceof SkillLibraryError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
