import { basename } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import { listProjects, type Project } from "../db/repositories/projects.ts";
import { HttpError } from "../http/errors.ts";
import { nextProjectID } from "../http/projects/projectSync.ts";
import type { NodePathCheckResult } from "./agent.ts";
import { NodeOfflineError, type NodeHub } from "./hub.ts";
import { projectLocation, remoteProjectCwd } from "./projectLocation.ts";

/** 与 /api/projects/path-check 同形，额外给出节点信息；路径由节点检查。 */
export async function checkRemoteProjectPath(db: RunnerDatabase, hub: NodeHub, nodeId: string, path: string) {
  const checked = await nodePathCheck(db, hub, nodeId, path);
  const cwd = remoteProjectCwd(nodeId, checked.path);
  const projects = listProjects(db);
  const existing = projects.find((project) => project.cwd === cwd);
  return {
    directory: checked.directory,
    exists: checked.exists,
    existing_project_id: existing?.id || null,
    git_repo: checked.git_repo,
    node_id: nodeId,
    node_path: checked.path,
    suggested_id: existing?.id || nextProjectID(basename(checked.path), cwd, new Set(projects.map((project) => project.id)))
  };
}

/**
 * 创建/更新项目前把 `node_id + cwd` 转成远程 cwd。
 * - body 带 node_id：非空即远程项目（cwd 是节点上的路径），空串表示改回本机；
 * - 未带 node_id 但当前项目在远程节点上且改了 cwd：视为同一节点上的新路径。
 */
export async function prepareRemoteProjectBody(
  db: RunnerDatabase,
  hub: NodeHub,
  body: Record<string, unknown>,
  current?: Project
): Promise<Record<string, unknown>> {
  const { node_id: rawNodeId, ...rest } = body;
  const currentNode = current ? projectLocation(current.cwd).nodeId : "";
  const nodeId = rawNodeId === undefined ? (typeof body.cwd === "string" ? currentNode : "") : String(rawNodeId ?? "").trim();
  if (nodeId === "") return rest;
  const path = typeof body.cwd === "string" ? body.cwd : current ? projectLocation(current.cwd).path : "";
  const checked = await nodePathCheck(db, hub, nodeId, path);
  if (!checked.directory) throw new HttpError(400, "节点上不存在该文件夹");
  return { ...rest, cwd: remoteProjectCwd(nodeId, checked.path) };
}

async function nodePathCheck(db: RunnerDatabase, hub: NodeHub, nodeId: string, path: string): Promise<NodePathCheckResult> {
  const node = getRemoteNode(db, nodeId);
  if (!node || node.revoked_at !== "") throw new HttpError(404, "节点不存在");
  if (path.trim() === "" || path.includes("\0")) throw new HttpError(400, "请输入节点上文件夹的绝对路径");
  try {
    return await hub.request(nodeId, "path.check", { path: path.trim() }, 10_000) as NodePathCheckResult;
  } catch (error) {
    if (error instanceof NodeOfflineError) throw new HttpError(409, "节点离线，无法检查路径");
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}
