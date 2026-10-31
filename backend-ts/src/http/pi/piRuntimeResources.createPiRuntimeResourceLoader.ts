import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { buildSkillPromptContext } from "../../skills/promptContext.ts";
import { jevAvailableForContext } from "../../skills/jev/policy.ts";
import { JEV_SKILL_ID } from "../../skills/jev/config.ts";
import type { SmokeRuntime } from "../../spikes/piSmokeSupport.ts";
import type { RuntimeSessionInput } from "./piRuntime.ts";
import { libraryRegistryOptions } from "../../skills/libraryContext.ts";
import { resolveSkillFile } from "../../skills/registry.ts";
import { visibleManagedSkills } from "../../skills/managedStore.ts";
import { verifyLibrarySkill } from "../../skills/libraryService.ts";
import { unique } from "../../util/values.ts";
import type { ControlledPiResourceOptions, PiRuntimeResourceSnapshot, PiRuntimeResourceDiagnostic } from "./piRuntimeResources.model.ts";
import { createControlledPiResourceLoader, recordPiRuntimeResourceSnapshot } from "./piRuntimeResources.controlledPiResourceLoader.ts";

export async function createPiRuntimeResourceLoader(
  sdk: SmokeRuntime,
  db: RunnerDatabase,
  input: RuntimeSessionInput,
  options: Omit<ControlledPiResourceOptions, "allowedSkillIDs" | "onSnapshot">
): Promise<ResourceLoader & { snapshot(): PiRuntimeResourceSnapshot }> {
  const promptProject = input.toolProject ?? input.project;
  const optionalJev = input.promptProfile !== "notification" && input.promptProfile !== "memory_reflection" && jevAvailableForContext(db, { ...input, projectID: promptProject?.id });
  const resourceScope = input.promptProfile === "chat" || input.promptProfile === "manager_cycle" ? "full" : "core";
  const skillContext = resourceScope === "full"
    ? buildSkillPromptContext(db, { ...input, project: promptProject })
    : { audit: { injected_skill_ids: [], missing_skill_intents: [] } };
  const allowedSkillIDs = unique([
    ...skillContext.audit.injected_skill_ids,
    ...skillContext.audit.missing_skill_intents.filter(id => id !== JEV_SKILL_ID),
    ...(optionalJev ? [JEV_SKILL_ID] : [])
  ]);
  const managed = visibleManagedSkills(dirname(db.path), promptProject?.id);
  const skillLoadDiagnostics: PiRuntimeResourceDiagnostic[] = [];
  const skillPaths = (await Promise.all(allowedSkillIDs.map(async id => {
    const installed = managed.find(item => item.id === id);
    if (installed) {
      try {
        const verified = await verifyLibrarySkill(db, installed.key);
        if (verified.status === "blocked") throw new Error("Skill dependencies unavailable");
      }
      catch {
        skillLoadDiagnostics.push({ code: "installed_skill_invalid", message: `Skill ${id} failed integrity, dependency or SDK validation; run skill_verify for details`, resource_type: "skill", severity: "error", source_path: `installed:${id}` });
        return [];
      }
    }
    const path = resolveSkillFile(id, libraryRegistryOptions(db, promptProject));
    return path ? [path] : [];
  }))).flat();
  return await createControlledPiResourceLoader(sdk, {
    ...options,
    allowedSkillIDs,
    skillPaths,
    skillLoadDiagnostics,
    resourceScope,
    onSnapshot: (snapshot) => recordPiRuntimeResourceSnapshot(db, input, promptProject?.id, snapshot)
  });
}
