import { formatJSON } from "./output.ts";
import { parseFlags, enabled } from "./maintenance.arguments.ts";
import { COMMANDS } from "./maintenance.commands.ts";
import type { Report } from "./maintenance.model.ts";

export function runMaintenance(args: string[]): string {
  const family = args[0]?.trim();
  const command = args[1]?.trim();
  if (!family || !command) throw new Error("usage: maintenance <events|db|attention> <command> [flags]");
  const flags = parseFlags(args.slice(2));
  const definition = COMMANDS[`${family} ${command}`];
  if (!definition) throw new Error(`unknown maintenance command: ${family} ${command}`);
  const allowed = new Set([...definition.flags, "json"]);
  const unknown = Object.keys(flags).find((name) => !allowed.has(name));
  if (unknown) throw new Error(`Unknown argument: --${unknown}`);
  const report = definition.run(flags);
  return enabled(flags, "json") ? formatJSON(report) : humanSummary(report, flags.report);
}

export function humanSummary(report: Report, reportPath: string | undefined): string {
  const operation = String(report.operation ?? "maintenance");
  return `${operation} dry_run=${Boolean(report.dry_run)} paused=${Boolean(report.paused)}${reportPath ? ` report=${reportPath}` : ""}\n`;
}
