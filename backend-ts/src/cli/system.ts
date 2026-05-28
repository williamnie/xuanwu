import { parseCommandArgs } from "./common.ts";
import { getJSON } from "./http.ts";
import { formatSystemStatus } from "./output.ts";
import type { EnvReader, Fetcher, SystemStatusDTO } from "./types.ts";

export async function runSystem(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing system command");
  if (command !== "status" && command !== "doctor") throw new Error(`unknown system command: ${command}`);
  return await getSystemStatus(args.slice(1), env, fetcher);
}

export async function getSystemStatus(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common } = parseCommandArgs(args, [], env);
  const status = await getJSON<SystemStatusDTO>(fetcher, common, "/api/system/status");
  return formatSystemStatus(status, common.json);
}
