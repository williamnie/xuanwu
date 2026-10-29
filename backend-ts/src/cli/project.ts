import { parseCommandArgs } from "./common.ts";
import { getJSON, postJSON } from "./http.ts";
import { formatJSON, formatProject } from "./output.ts";
import type { NodeListDTO } from "./node.ts";
import type { EnvReader, Fetcher, ProjectDTO } from "./types.ts";

const PROJECT_CREATE_FLAGS = [
  { name: "id" },
  { name: "node-id" },
  { name: "name" },
  { name: "cwd", required: true },
  { name: "provider" },
  { name: "default-agent-profile" },
  { name: "model" },
  { name: "approval-policy" },
  { name: "sandbox" }
] as const;

export async function runProject(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing project command");
  if (command === "list") return await listProjects(args.slice(1), env, fetcher);
  if (command === "create") return await createProject(args.slice(1), env, fetcher);
  throw new Error(`unknown project command: ${command}`);
}

async function createProject(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...PROJECT_CREATE_FLAGS], env);
  if (values["node-id"] || !values.id) {
    const query = new URLSearchParams({ cwd: values.cwd });
    if (values["node-id"]) query.set("node_id", values["node-id"]);
    const checked = await getJSON<{ directory: boolean; suggested_id: string }>(
      fetcher, common, `/api/projects/path-check?${query}`
    );
    if (!checked.directory) throw new Error(values["node-id"] ? "节点上不存在该文件夹" : "本机上不存在该文件夹");
    if (!values.id) {
      if (!checked.suggested_id) throw new Error("path-check 未返回 suggested_id");
      values.id = checked.suggested_id;
    }
  }
  const project = await postJSON<ProjectDTO>(fetcher, common, "/api/projects", projectPayload(values));
  return formatProject(project, common.json);
}

function projectPayload(values: Record<string, string>): Record<string, unknown> {
  return {
    id: values.id,
    ...(values["node-id"] ? { node_id: values["node-id"] } : {}),
    name: values.name ?? "",
    cwd: values.cwd,
    provider: values.provider ?? "codex",
    default_agent_profile_id: values["default-agent-profile"] ?? "",
    model: values.model ?? "",
    approval_policy: values["approval-policy"] ?? "never",
    sandbox: values.sandbox ?? "workspace-write"
  };
}

async function listProjects(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common } = parseCommandArgs(args, [], env);
  const projects = await getJSON<ProjectDTO[]>(fetcher, common, "/api/projects");
  const nodes = projects.some(project => project.node_id)
    ? (await getJSON<NodeListDTO>(fetcher, common, "/api/nodes")).nodes : [];
  const names = new Map(nodes.map(node => [node.id, node.name]));
  const rows = projects.map(project => ({
    ...project,
    node_id: project.node_id ?? "",
    location: project.node_id
      ? `${names.get(project.node_id) || project.node_id}:${project.node_path || project.cwd}`
      : project.cwd
  }));
  if (common.json) return formatJSON(rows);
  return "id\t名称\t位置\tnode_id\n" + rows.map(project =>
    `${project.id}\t${project.name ?? ""}\t${project.location}\t${project.node_id}\n`
  ).join("");
}
