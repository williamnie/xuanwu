import { basename, join } from "node:path";
import { redactSensitiveText } from "../util/redact.ts";
import type { IssueEvent, ListIssueEventsOptions } from "./repositories/issueEvents.ts";

const WORKER_TIMEOUT_MS = 30_000;
const DEFAULT_ASYNC_EVENT_LIMIT = 100;

type WorkerResult = {
  events?: IssueEvent[];
  error?: string;
  ok?: boolean;
};

export async function listIssueEventsAsync(
  dbPath: string,
  issueID: number,
  options: ListIssueEventsOptions = {}
): Promise<IssueEvent[]> {
  const preserveLegacyOrder = options.limit === undefined &&
    options.afterID === undefined &&
    options.beforeID === undefined;
  const workerArgs = [
    "__issue-events-read-worker",
    dbPath,
    String(issueID),
    encodeOptions({
      ...options,
      hydrateArtifacts: options.hydrateArtifacts === true,
      limit: options.limit ?? DEFAULT_ASYNC_EVENT_LIMIT
    }),
    String(process.pid)
  ];
  const command = basename(process.execPath).startsWith("bun")
    ? [process.execPath, join(import.meta.dir, "../main.ts"), ...workerArgs]
    : [process.execPath, ...workerArgs];
  const child = Bun.spawn({
    cmd: command,
    env: workerEnvironment(),
    stderr: "pipe",
    stdout: "pipe"
  });
  const timeout = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) {
    const detail = redactSensitiveText(stderr.trim() || stdout.trim()).slice(0, 2_000);
    throw new Error(`issue event read worker failed (${exitCode}): ${detail}`);
  }
  const parsed = JSON.parse(stdout) as WorkerResult;
  if (!parsed.ok || !Array.isArray(parsed.events)) {
    throw new Error(parsed.error || "issue event read worker returned an invalid result");
  }
  return preserveLegacyOrder ? parsed.events.sort(compareIssueEvents) : parsed.events;
}

export function decodeIssueEventWorkerOptions(value: string): ListIssueEventsOptions {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ListIssueEventsOptions;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function encodeOptions(options: ListIssueEventsOptions): string {
  return Buffer.from(JSON.stringify(options)).toString("base64url");
}

function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "PATH", "TMPDIR", "TZ"]
    .map((key) => [key, Bun.env[key] ?? ""])
    .filter(([, value]) => value !== ""));
}

function compareIssueEvents(left: IssueEvent, right: IssueEvent): number {
  return left.created_at.localeCompare(right.created_at) || left.id - right.id;
}
