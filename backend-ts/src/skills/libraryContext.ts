import { dirname, join } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import type { Project } from "../db/repositories/projects.ts";
import { currentSkillRevision, revisionPath, skillStoreRoot, visibleManagedSkills } from "./managedStore.ts";
import type { SkillRegistryOptions } from "./registry.ts";

export function libraryRegistryOptions(db: RunnerDatabase, project?: Pick<Project, "id" | "cwd">): SkillRegistryOptions {
  const stateDir = dirname(db.path);
  return {
    cwd: project?.cwd,
    agentDir: join(stateDir, "pi-runtime", "agent"),
    additionalRoots: visibleManagedSkills(stateDir, project?.id).map(skill => ({
      label: `installed-${skill.scope}-${skill.key}`,
      path: revisionPath(stateDir, currentSkillRevision(skill)),
      boundary: skillStoreRoot(stateDir)
    }))
  };
}

export function managedSkillPolicy(db: RunnerDatabase, projectID?: string) {
  const effective = new Map<string, boolean>();
  for (const item of visibleManagedSkills(dirname(db.path), projectID)) if (!effective.has(item.id)) effective.set(item.id, item.enabled);
  return { enabled: [...effective].filter(([, enabled]) => enabled).map(([id]) => id), disabled: [...effective].filter(([, enabled]) => !enabled).map(([id]) => id) };
}
