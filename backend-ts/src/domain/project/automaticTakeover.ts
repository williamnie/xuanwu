import type { RunnerDatabase } from "../../db/database.ts";
import { DEFAULT_PI_AGENT_ID, ensureDefaultPiAgent } from "../../db/defaultPiAgent.ts";
import {
  createProjectPiSettings,
  getProjectPiSettings,
  type ProjectPiSettings
} from "../../db/repositories/pi.ts";
import {
  createProject,
  getProject,
  ProjectNotFoundError,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
  updateProject
} from "../../db/repositories/projects.ts";

export function createAutomaticallyManagedProject(
  db: RunnerDatabase,
  input: CreateProjectInput
): Project {
  return db.transaction(() => {
    ensureSupervisorEnabled(db);
    const project = createProject(db, { ...input, auto_run: 1 });
    ensureTakeoverBinding(db, project.id);
    return requireProject(db, project.id);
  }).immediate();
}

export function updateAutomaticallyManagedProject(
  db: RunnerDatabase,
  projectID: string,
  input: UpdateProjectInput
): Project {
  return db.transaction(() => {
    ensureSupervisorEnabled(db);
    const project = updateProject(db, projectID, { ...input, auto_run: 1 });
    ensureTakeoverBinding(db, project.id);
    return requireProject(db, project.id);
  }).immediate();
}

export function ensureProjectAutomaticTakeover(db: RunnerDatabase, projectID: string): Project {
  return db.transaction(() => {
    ensureSupervisorEnabled(db);
    const project = requireProject(db, projectID);
    db.sqlite.run(`update projects set auto_run=1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=?`, [project.id]);
    ensureTakeoverBinding(db, project.id);
    return requireProject(db, project.id);
  }).immediate();
}

export function bindProjectAutomaticTakeover(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return db.transaction(() => {
    ensureSupervisorEnabled(db);
    const project = requireProject(db, projectID);
    db.sqlite.run(`update projects set auto_run=1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=?`, [project.id]);
    return ensureTakeoverBinding(db, project.id);
  }).immediate();
}

function ensureTakeoverBinding(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return getProjectPiSettings(db, projectID) ?? createProjectPiSettings(db, { project_id: projectID });
}

function ensureSupervisorEnabled(db: RunnerDatabase): void {
  ensureDefaultPiAgent(db);
  db.sqlite.run(`update pi_agents set enabled=1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=? and enabled<>1`, [DEFAULT_PI_AGENT_ID]);
}

function requireProject(db: RunnerDatabase, projectID: string): Project {
  const project = getProject(db, projectID);
  if (!project) throw new ProjectNotFoundError();
  return project;
}
