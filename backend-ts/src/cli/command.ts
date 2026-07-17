import { sanitizeError } from "./common.ts";
import { runIssue } from "./issue.ts";
import { runMaintenance } from "./maintenance.ts";
import { runProject } from "./project.ts";
import { getSystemDoctor, runSystem } from "./system.ts";
import { runWork } from "./work.ts";
import type { CliOptions, EnvReader, Fetcher, Writer } from "./types.ts";

export async function runCli(
  args: string[],
  out: Writer = process.stdout,
  errOut: Writer = process.stderr,
  options: CliOptions = {}
): Promise<number> {
  try {
    const output = await dispatch(args, options.env ?? envReader, options.fetch ?? fetch);
    if (output !== "") out.write(output);
    return 0;
  } catch (error) {
    errOut.write(`${sanitizeError(error)}\n`);
    return 1;
  }
}

async function dispatch(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing command");
  if (command === "issue") return await runIssue(args.slice(1), env, fetcher);
  if (command === "maintenance") return runMaintenance(args.slice(1));
  if (command === "project") return await runProject(args.slice(1), env, fetcher);
  if (command === "work") return await runWork(args.slice(1), env, fetcher);
  if (command === "system") return await runSystem(args.slice(1), env, fetcher);
  if (command === "doctor") return await getSystemDoctor(args.slice(1), env, fetcher);
  throw new Error(`unknown command: ${command}`);
}

function envReader(key: string): string | undefined {
  return Bun.env[key];
}
