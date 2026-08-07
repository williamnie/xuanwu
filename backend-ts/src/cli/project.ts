import { parseCommandArgs } from "./common.ts";
import { postJSON } from "./http.ts";
import { formatProject } from "./output.ts";
import type { EnvReader, Fetcher, ProjectDTO } from "./types.ts";

const PROJECT_CREATE_FLAGS = [
  { name: "id", required: true },
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
  if (command === "create") return await createProject(args.slice(1), env, fetcher);
  throw new Error(`unknown project command: ${command}`);
}

async function createProject(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...PROJECT_CREATE_FLAGS], env);
  const project = await postJSON<ProjectDTO>(fetcher, common, "/api/projects", projectPayload(values));
  return formatProject(project, common.json);
}

function projectPayload(values: Record<string, string>): Record<string, unknown> {
  return {
    id: values.id,
    name: values.name ?? "",
    cwd: values.cwd,
    provider: values.provider ?? "codex",
    default_agent_profile_id: values["default-agent-profile"] ?? "",
    model: values.model ?? "",
    approval_policy: values["approval-policy"] ?? "never",
    sandbox: values.sandbox ?? "workspace-write"
  };
}
