import { type PendingRequest, type CodexJsonRpcProcess } from "./jsonRpcModel.ts";

export const MAX_LINE_BYTES = 10 * 1024 * 1024;

export function clearPendingTimeout(request: PendingRequest | undefined): void {
  if (request?.timeout) clearTimeout(request.timeout);
}

export function isRequestId(value: unknown): value is string | number {
  return typeof value === "number" || typeof value === "string";
}

export function spawnCodexProcess({ command, cwd, env }: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}): CodexJsonRpcProcess {
  return Bun.spawn(command, { cwd, detached: true, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

export function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) ?? [];
  if (parts.length === 0) throw new Error("codex command is empty");
  return parts;
}

export function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onError?: (error: Error) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainLines(buffer, onLine);
      if (buffer.length > MAX_LINE_BYTES) throw new Error("codex app-server stdout frame exceeds limit");
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") onLine(buffer);
  } catch (error) {
    onError?.(asError(error));
  } finally {
    reader.releaseLock();
  }
}

export function drainLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  while (true) {
    const index = buffer.indexOf("\n", start);
    if (index < 0) return buffer.slice(start);
    const line = buffer.slice(start, index).replace(/\r$/, "");
    if (line.trim() !== "") onLine(line);
    start = index + 1;
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
