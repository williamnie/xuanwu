import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { redactEvidenceText } from "../evidence/contracts.ts";

export type LocalGitCommandResult = {
  code: number;
  stderr: Buffer;
  stdout: Buffer;
};

export type LocalGitIdentity = {
  email: string;
  name: string;
};

export type LocalGitRunInput = {
  allowed_exit_codes?: readonly number[];
  args: readonly string[];
  identity?: LocalGitIdentity;
  index_file?: string;
  repository_path: string;
};

export interface LocalGitAdapter {
  run(input: LocalGitRunInput): Promise<LocalGitCommandResult>;
}

export type LocalGitAdapterOptions = {
  git_binary?: string;
  max_output_bytes?: number;
};

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

export function createLocalGitAdapter(options: LocalGitAdapterOptions = {}): LocalGitAdapter {
  const binary = requiredText(options.git_binary ?? "git", "git binary");
  const outputLimit = boundedPositiveInteger(
    options.max_output_bytes,
    DEFAULT_MAX_GIT_OUTPUT_BYTES,
    MAX_GIT_OUTPUT_BYTES
  );

  return {
    async run(input) {
      const repositoryPath = resolve(requiredText(input.repository_path, "Git repository path"));
      const allowedExitCodes = input.allowed_exit_codes ?? [0];
      if (allowedExitCodes.length === 0 || allowedExitCodes.some((code) => !Number.isInteger(code))) {
        throw new Error("allowed Git exit codes must be integers");
      }
      const indexFile = normalizedIndexFile(input.index_file);
      const identity = normalizedIdentity(input.identity);
      const result = await spawnAndCapture(binary, [
        "-c", "core.fsmonitor=false",
        "-c", "core.hooksPath=/dev/null",
        "-c", "diff.external=",
        "-C", repositoryPath,
        ...input.args
      ], safeGitEnvironment(repositoryPath, indexFile, identity), outputLimit);
      if (!allowedExitCodes.includes(result.code)) {
        const detail = redactEvidenceText(result.stderr.toString("utf8").trim()).slice(0, 1024);
        throw new Error(
          `git ${input.args[0] ?? "command"} failed with exit ${result.code}${detail ? `: ${detail}` : ""}`
        );
      }
      return result;
    }
  };
}

function spawnAndCapture(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outputLimit: number
): Promise<LocalGitCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (overflow) return rejectPromise(new Error(`Git output exceeded ${outputLimit} bytes`));
      if (code === null) return rejectPromise(new Error("Git process ended without an exit code"));
      resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function safeGitEnvironment(
  repositoryPath: string,
  indexFile: string | undefined,
  identity: LocalGitIdentity | undefined
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CEILING_DIRECTORIES: dirname(repositoryPath),
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: repositoryPath,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? ""
  };
  if (indexFile) environment.GIT_INDEX_FILE = indexFile;
  if (identity) {
    environment.GIT_AUTHOR_EMAIL = identity.email;
    environment.GIT_AUTHOR_NAME = identity.name;
    environment.GIT_COMMITTER_EMAIL = identity.email;
    environment.GIT_COMMITTER_NAME = identity.name;
  }
  if (process.platform === "win32") {
    environment.ComSpec = process.env.ComSpec;
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

function normalizedIndexFile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = requiredText(value, "Git index file");
  if (!isAbsolute(path)) throw new Error("Git index file must be absolute");
  return resolve(path);
}

function normalizedIdentity(value: LocalGitIdentity | undefined): LocalGitIdentity | undefined {
  if (!value) return undefined;
  const name = requiredText(value.name, "Git identity name");
  const email = requiredText(value.email, "Git identity email");
  if (/\r|\n|\0/.test(name) || /\r|\n|\0/.test(email)) throw new Error("Git identity cannot contain control lines");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Git identity email is invalid");
  return { email, name };
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (text === "") throw new Error(`${label} is required`);
  if (text.includes("\0")) throw new Error(`${label} cannot contain NUL`);
  return text;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Git output byte limit must be between 1 and ${maximum}`);
  }
  return value;
}
