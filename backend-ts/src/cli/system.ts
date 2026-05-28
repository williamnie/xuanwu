import { parseCommandArgs } from "./common.ts";
import { getJSON } from "./http.ts";
import { formatSystemLogs, formatSystemStatus } from "./output.ts";
import type { EnvReader, Fetcher, SystemLogsDTO, SystemStatusDTO } from "./types.ts";

export async function runSystem(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing system command");
  if (command === "status" || command === "doctor") return await getSystemStatus(args.slice(1), env, fetcher);
  if (command === "logs") return await getSystemLogs(args.slice(1), env, fetcher);
  throw new Error(`unknown system command: ${command}`);
}

export async function getSystemStatus(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common } = parseCommandArgs(args, [], env);
  const status = await getJSON<SystemStatusDTO>(fetcher, common, "/api/system/status");
  return formatSystemStatus(status, common.json);
}

async function getSystemLogs(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [{ name: "lines" }], env);
  const query = values.lines ? `?lines=${encodeURIComponent(values.lines)}` : "";
  const logs = await getJSON<SystemLogsDTO>(fetcher, common, `/api/system/logs${query}`);
  return formatSystemLogs(logs, common.json);
}
