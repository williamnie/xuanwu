import { parseCommandArgs } from "./common.ts";
import { getJSON, postJSON } from "./http.ts";
import { formatJSON } from "./output.ts";
import type { EnvReader, Fetcher } from "./types.ts";

const CREATE_FLAGS = [
  { name: "project", required: true },
  { name: "title", required: true },
  { name: "goal", required: true },
  { name: "status" },
  { name: "occurred-at", required: true },
  { name: "idempotency-key", required: true }
] as const;
const ID_FLAGS = [{ name: "id", required: true }] as const;

/**
 * A narrow CLI projection of the P02.06 Work HTTP API.  Mutations require a
 * caller-supplied key so retries from CI/agents reuse the authoritative audit
 * event rather than accidentally creating a second Issue-backed Work.
 */
export async function runWork(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (command === "create") return await createWork(args.slice(1), env, fetcher);
  if (command === "status" || command === "result") return await getWork(args.slice(1), env, fetcher, command);
  if (command === "timeline") return await getTimeline(args.slice(1), env, fetcher);
  throw new Error(`unknown work command: ${command || ""}`.trim());
}

async function createWork(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...CREATE_FLAGS], env);
  const key = requiredKey(values["idempotency-key"]);
  const occurredAt = timestamp(values["occurred-at"]);
  const response = await postJSON<Record<string, unknown>>(fetcher, common, "/api/works", {
    audit: {
      actor: { id: "codex-issue-runner-cli", kind: "user" },
      correlation_id: `cli-work:${key}`,
      event_id: `cli-work:${key}`,
      occurred_at: occurredAt,
      reason: "CLI Work create"
    },
    goal: values.goal,
    project_id: values.project,
    status: values.status || "triage",
    title: values.title,
    type: "engineering_task"
  });
  return format(response, common.json);
}

async function getWork(args: string[], env: EnvReader, fetcher: Fetcher, command: "status" | "result"): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const response = await getJSON<Record<string, unknown>>(fetcher, common, `/api/works/${encodeURIComponent(workID(values.id))}`);
  if (command === "status") return format(response, common.json);
  return format({ work: response.work }, common.json);
}

async function getTimeline(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const response = await getJSON<Record<string, unknown>>(fetcher, common, `/api/works/${encodeURIComponent(workID(values.id))}/timeline`);
  return format(response, common.json);
}

function format(value: Record<string, unknown>, json: boolean): string {
  if (json) return formatJSON(value);
  const work = object(value.work);
  const id = string(work.id);
  const status = string(work.status);
  if (id !== "" && status !== "") return `${id} ${status}\n`;
  return formatJSON(value);
}

function requiredKey(value: string | undefined): string {
  const key = (value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(key)) {
    throw new Error("--idempotency-key must contain 1-192 letters, numbers, ., _, : or -");
  }
  return key;
}

function timestamp(value: string | undefined): string {
  const text = (value ?? "").trim();
  if (!Number.isFinite(Date.parse(text))) throw new Error("--occurred-at must be an ISO timestamp");
  return text;
}

function workID(value: string | undefined): string {
  const id = (value ?? "").trim();
  if (id === "") throw new Error("--id is required");
  return id;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
