import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { getProject, listProjects, ProjectNotFoundError, type Project } from "./projects.ts";

export function deleteProject(db: RunnerDatabase, id: string): void {
  const result = db.sqlite.run("delete from projects where id=?", [id.trim()]);
  if (result.changes === 0) throw new ProjectNotFoundError();
}

export function reorderProjects(db: RunnerDatabase, ids: string[]): Project[] {
  const cleanIDs = ids.map((id) => id.trim()).filter(Boolean);
  validateProjectOrder(db, cleanIDs);
  const timestamp = issueTimestamp();
  const write = db.transaction((projectIDs: string[]) => {
    projectIDs.forEach((id, index) => {
      db.sqlite.run("update projects set sort_order=?, updated_at=? where id=?", [index + 1, timestamp, id]);
    });
  });
  write(cleanIDs);
  return listProjects(db);
}

export function clearProjectHold(db: RunnerDatabase, id: string): Project {
  const projectID = id.trim();
  const result = db.sqlite.run("delete from project_holds where project_id=?", [projectID]);
  if (result.changes === 0 && !getProject(db, projectID)) throw new ProjectNotFoundError();
  const project = getProject(db, projectID);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function validateProjectOrder(db: RunnerDatabase, ids: string[]): void {
  if (ids.length === 0) throw new Error("project order 不能为空");
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("project id 重复");
  const existing = db.sqlite.query<{ id: string }, []>("select id from projects").all().map((row) => row.id);
  if (existing.length !== ids.length) throw new Error("project order 必须包含全部项目");
  for (const id of existing) if (!unique.has(id)) throw new Error(`project order 缺少项目: ${id}`);
}
