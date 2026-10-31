import type { ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { collectDarwinPhysicalFootprints } from "./darwinProcessMemory.ts";
import type { ObservedProcess } from "./processGroupMemory.model.ts";

export function inspectMemoryProcessTable(): ProcessTreeEntry[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,rss=,lstart=,command="], { stderr: "ignore", stdout: "pipe" });
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).split("\n").map(parseMemoryProcessRow).filter(isProcessRow);
}

export async function collectMacOSFootprint(pids: number[]): Promise<Map<number, number>> {
  return await collectDarwinPhysicalFootprints(pids);
}

export function parseMemoryProcessRow(line: string): ProcessTreeEntry | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return;
  return {
    command: `${match[5]}\t${match[6]}`,
    pgid: Number(match[3]), pid: Number(match[1]), ppid: Number(match[2]), rss_bytes: Number(match[4]) * 1024
  };
}

export function processStartedAt(row: ProcessTreeEntry): string {
  if (!row.command.includes("\t")) return "unknown";
  const [value] = row.command.split("\t", 1);
  return value?.trim() && value !== "unknown" ? value : "unknown";
}

export function rawCommand(command: string): string { return command.includes("\t") ? command.slice(command.indexOf("\t") + 1) : command; }

export function descendantTree(rows: ProcessTreeEntry[], rootPID: number): ProcessTreeEntry[] {
  const root = rows.find((row) => row.pid === rootPID);
  if (!root) return [];
  const selected = new Map<number, ProcessTreeEntry>([[root.pid, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.pid) || !selected.has(row.ppid)) continue;
      selected.set(row.pid, row);
      changed = true;
    }
  }
  return [...selected.values()];
}

export function processRole(command: string, providerOwned: boolean): string {
  const value = rawCommand(command).toLowerCase();
  if (value.includes("xuanwu-agentic")) return "agentic-worker";
  if (value.includes("__usage-index-worker")) return "usage-index";
  if (value.includes("app-server")) return "codex-app-server";
  if (value.includes("code-mode-host")) return "tool-host";
  if (value.includes("mcp") || value.includes("plugin-appserver")) return "mcp";
  return providerOwned ? "provider-child" : "runner-child";
}

export function genericOwner(command: string): string {
  const value = rawCommand(command);
  if (value.includes("xuanwu-agentic")) return "runner:agentic";
  return value.includes("__usage-index-worker") ? "runner:usage-index" : "runner:child";
}

export function safeOwner(owners: string[]): string {
  if (owners.length === 0) return "provider:idle-ttl";
  if (owners.length > 1) return `provider:multiple:${owners.length}`;
  return redactSensitiveText(owners[0] ?? "provider").replace(/[^A-Za-z0-9:._~-]/g, "?").slice(0, 160);
}

export function roleSummaries(rows: ObservedProcess[]): Array<Record<string, unknown>> {
  const roles = new Map<string, ObservedProcess[]>();
  for (const row of rows) roles.set(row.role, [...(roles.get(row.role) ?? []), row]);
  return [...roles].map(([role, items]) => ({
    process_count: items.length,
    role,
    rss_bytes: items.reduce((total, item) => total + item.rss_bytes, 0),
    top: publicProcesses([...items].sort((left, right) => right.rss_bytes - left.rss_bytes).slice(0, 3))
  })).sort((left, right) => Number(right.rss_bytes) - Number(left.rss_bytes));
}

export function publicProcesses(rows: ObservedProcess[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    owner: row.owner, pid: row.pid, ppid: row.ppid, role: row.role, rss_bytes: row.rss_bytes, started_at: row.started_at
  }));
}

export function isMemoryProbe(command: string): boolean {
  const value = rawCommand(command);
  return value.includes("ps -axo pid=,ppid=,pgid=,rss=,lstart=,command=") || value.includes("/usr/bin/footprint -f bytes --noCategories");
}

export function isProcessRow(value: ProcessTreeEntry | undefined): value is ProcessTreeEntry { return value !== undefined; }
