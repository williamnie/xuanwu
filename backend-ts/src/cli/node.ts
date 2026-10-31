import { parseCommandArgs } from "./common.ts";
import { getJSON } from "./http.ts";
import { formatJSON } from "./output.ts";
import type { EnvReader, Fetcher } from "./types.ts";

export type NodeListDTO = {
  nodes: Array<{
    id: string;
    name: string;
    online: boolean;
    info: { providers: Array<{ id: string; ready: boolean }>; version: string };
  }>;
};

export async function runNode(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  if (args[0] !== "list") throw new Error(args[0] ? `unknown node command: ${args[0]}` : "missing node command");
  const { common } = parseCommandArgs(args.slice(1), [], env);
  const result = await getJSON<NodeListDTO>(fetcher, common, "/api/nodes");
  if (common.json) return formatJSON(result);
  return "id\t名称\t状态\t可用 provider\t版本\n" + result.nodes.map(node =>
    `${node.id}\t${node.name}\t${node.online ? "online" : "offline"}\t${node.info.providers.filter(provider => provider.ready).map(provider => provider.id).join(",") || "-"}\t${node.info.version}\n`
  ).join("");
}
