export type CodexDynamicExecObservation = {
  aggregatedOutput: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number;
  id: string;
  status: "completed" | "failed";
  type: "commandExecution";
};

/**
 * Codex unified exec is exposed by app-server as a dynamicToolCall rather than
 * a commandExecution item. Recover only the narrow, machine-generated
 * tools.exec_command({ ... }) shape and require a terminal wrapper outcome.
 */
export function codexDynamicExecObservation(item: Record<string, unknown>): CodexDynamicExecObservation | undefined {
  if (stringValue(item.type) !== "dynamicToolCall" || stringValue(item.tool) !== "exec") return undefined;
  const input = dynamicToolInput(item.arguments);
  const calls = execCommandCalls(input);
  if (calls.length !== 1) return undefined;
  const command = stringValue(calls[0].cmd);
  if (command === "") return undefined;
  const output = dynamicToolOutput(item.contentItems);
  const exitCode = dynamicToolExitCode(item, output);
  if (exitCode === undefined) return undefined;
  return {
    aggregatedOutput: output,
    command,
    cwd: stringValue(calls[0].workdir) || ".",
    durationMs: nonNegativeInteger(item.durationMs),
    exitCode,
    id: stringValue(item.id),
    status: exitCode === 0 ? "completed" : "failed",
    type: "commandExecution"
  };
}

function dynamicToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  const record = objectValue(value);
  return stringValue(record.input) || stringValue(record.code);
}

function execCommandCalls(input: string): Record<string, unknown>[] {
  const marker = "tools.exec_command(";
  const calls: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < input.length) {
    const markerIndex = input.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const start = skipWhitespace(input, markerIndex + marker.length);
    const candidate = jsonObjectAt(input, start);
    if (!candidate) return [];
    try {
      calls.push(objectValue(JSON.parse(candidate.value)));
    } catch {
      return [];
    }
    offset = candidate.end;
  }
  return calls;
}

function jsonObjectAt(input: string, start: number): { end: number; value: string } | undefined {
  if (input[start] !== "{") return undefined;
  let depth = 0;
  let escaped = false;
  let quoted = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return { end: index + 1, value: input.slice(start, index + 1) };
  }
  return undefined;
}

function dynamicToolOutput(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const item = objectValue(entry);
    return stringValue(item.text);
  }).filter(Boolean).join("\n");
}

function dynamicToolExitCode(item: Record<string, unknown>, output: string): number | undefined {
  if (/^Script completed(?:\r?\n|$)/.test(output)) return 0;
  if (/^Script (?:failed|terminated)(?:\r?\n|$)/.test(output)) return 1;
  if (item.success === false || stringValue(item.status) === "failed") return 1;
  return undefined;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
