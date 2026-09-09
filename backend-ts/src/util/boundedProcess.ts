import { spawn } from "node:child_process";

export type BoundedProcessResult = {
  error?: Error & { code?: string };
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};
export type BoundedProcessInput = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  input: string;
  stdoutLimit: number;
  stderrLimit: number;
  timeoutMs: number;
};

export function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
  const deadline = performance.now() + input.timeoutMs;
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd, env: input.env, detached: grouped, shell: false, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ...failed("ESPAWN", "Child process failed to start"), error: error as Error });
      return;
    }
    const result: BoundedProcessResult = { signal: null, status: null, stderr: "", stdout: "" };
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const killGroup = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* 子进程可能已经退出。 */ }
    };
    const stop = (error: BoundedProcessResult["error"]) => {
      result.error ??= error;
      killGroup();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timeout = setTimeout(() => stop(processError("ETIMEDOUT", "Child process timed out")), Math.max(1, deadline - performance.now()));
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const limit = kind === "stdout" ? input.stdoutLimit : input.stderrLimit;
      const remaining = Math.max(0, limit - sizes[kind]);
      if (remaining > 0) chunks[kind].push(chunk.subarray(0, remaining));
      sizes[kind] += chunk.length;
      if (sizes[kind] > limit) stop(processError("ENOBUFS", `Child ${kind} exceeded its byte limit`));
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", (error) => stop(error));
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      killGroup();
      resolve({ ...result, status, signal,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    });
    child.stdin?.end(input.input);
  });
}

function processError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function failed(code: string, message: string): BoundedProcessResult {
  return { error: processError(code, message), signal: null, status: null, stderr: "", stdout: "" };
}
