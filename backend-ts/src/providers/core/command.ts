import { statSync } from "node:fs";

export type CommandDetection = {
  installed: boolean;
  path?: string;
  reason?: string;
};

/** 只探测 argv[0]，不执行 shell，也不展开不可信参数。 */
export function detectProviderCommand(command: unknown): CommandDetection {
  const executable = firstArgument(typeof command === "string" ? command : "");
  if (executable === "") return { installed: false, reason: "provider command is empty" };
  const path = executable.includes("/") ? (isExecutable(executable) ? executable : "") : (Bun.which(executable) ?? "");
  return path
    ? { installed: true, path }
    : { installed: false, reason: `provider executable ${JSON.stringify(executable)} was not found` };
}

function firstArgument(command: string): string {
  const match = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/)?.[0] ?? "";
  if ((match.startsWith('"') && match.endsWith('"')) || (match.startsWith("'") && match.endsWith("'"))) {
    return match.slice(1, -1);
  }
  return match;
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
