import { readFileSync } from "node:fs";
import { redactSensitiveText } from "../util/redact.ts";
import type { EnvReader } from "./types.ts";

export type CommonFlags = {
  addr: string;
  json: boolean;
  token: string;
};

export type ParsedCommonArgs = {
  flags: CommonFlags;
  rest: string[];
};

export type FlagSpec = {
  boolean?: boolean;
  name: string;
  required?: boolean;
};

export type ParsedCommandArgs = {
  common: CommonFlags;
  values: Record<string, string>;
};

const DEFAULT_ADDR = "127.0.0.1:3008";
const TOKEN_ENV = "CODEX_RUNNER_AUTH_TOKEN";
const TOKEN_FILE_ENV = "CODEX_RUNNER_AUTH_TOKEN_FILE";

export function parseCommandArgs(args: string[], specs: FlagSpec[], env: EnvReader): ParsedCommandArgs {
  const parsed = parseCommonArgs(args, env);
  return { common: parsed.flags, values: parseSpecificFlags(parsed.rest, specs) };
}

export function parseCommonArgs(args: string[], env: EnvReader): ParsedCommonArgs {
  const rest: string[] = [];
  let addr = env("CODEX_RUNNER_ADDR")?.trim() || DEFAULT_ADDR;
  let json = false;
  let token = envToken(env);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { flag, inlineValue } = splitFlag(arg);
    if (flag === "--addr") {
      const parsed = readFlagValue(args, index, flag, inlineValue);
      addr = parsed.value;
      index = parsed.index;
    } else if (flag === "--json") {
      if (inlineValue !== undefined) throw new Error("--json does not take a value");
      json = true;
    } else if (flag === "--token") {
      const parsed = readFlagValue(args, index, flag, inlineValue);
      token = parsed.value.trim();
      index = parsed.index;
    } else if (flag === "--token-file") {
      const parsed = readFlagValue(args, index, flag, inlineValue);
      token = readTokenFile(parsed.value);
      index = parsed.index;
    } else {
      rest.push(arg);
    }
  }

  return { flags: { addr, json, token }, rest };
}

function parseSpecificFlags(args: string[], specs: FlagSpec[]): Record<string, string> {
  const values: Record<string, string> = {};
  const byFlag = new Map(specs.map((spec) => [`--${spec.name}`, spec]));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { flag, inlineValue } = splitFlag(arg);
    const spec = byFlag.get(flag);
    if (!spec) throw new Error(`Unknown argument: ${arg}`);
    if (spec.boolean) {
      if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`);
      values[spec.name] = "true";
    } else {
      const parsed = readFlagValue(args, index, flag, inlineValue);
      values[spec.name] = parsed.value;
      index = parsed.index;
    }
  }
  for (const spec of specs) {
    if (spec.required && clean(values[spec.name]) === "") throw new Error(`--${spec.name} is required`);
  }
  return values;
}

function envToken(env: EnvReader): string {
  const direct = clean(env(TOKEN_ENV));
  if (direct) return direct;
  return readTokenFile(clean(env(TOKEN_FILE_ENV)));
}

function readTokenFile(path: string): string {
  if (path.trim() === "") return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function readFlagValue(
  args: string[],
  index: number,
  flag: string,
  inlineValue: string | undefined
): { value: string; index: number } {
  const value = inlineValue ?? args[index + 1];
  if (clean(value) === "") throw new Error(`Missing value for ${flag}`);
  return { value, index: inlineValue === undefined ? index + 1 : index };
}

function splitFlag(arg: string): { flag: string; inlineValue?: string } {
  const separator = arg.indexOf("=");
  if (separator < 0) return { flag: arg };
  return { flag: arg.slice(0, separator), inlineValue: arg.slice(separator + 1) };
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}
