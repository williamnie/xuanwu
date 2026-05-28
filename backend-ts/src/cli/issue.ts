import { readFile } from "node:fs/promises";
import { parseCommandArgs } from "./common.ts";
import { getJSON, patchJSON, postJSON } from "./http.ts";
import { formatIssue, formatIssueEvents } from "./output.ts";
import type { EnvReader, Fetcher, IssueDTO, IssueEventDTO } from "./types.ts";

const CREATE_FLAGS = [
  { name: "project", required: true },
  { name: "title" },
  { name: "body" },
  { name: "body-file" },
  { name: "status" },
  { name: "priority" },
  { name: "template" },
  { name: "source-session" },
  { name: "source-turn" },
  { name: "source-excerpt" },
  { boolean: true, name: "run" }
] as const;

const UPDATE_FLAGS = [
  { name: "id", required: true },
  { name: "status" },
  { name: "error" }
] as const;

const ID_FLAGS = [{ name: "id", required: true }] as const;
const REVIEW_FLAGS = [
  { name: "id", required: true },
  { name: "action", required: true },
  { name: "comment" }
] as const;
const REVIEW_ACTIONS = new Set(["accept", "reject", "request-changes"]);

export async function runIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing issue command");
  if (command === "create") return await createIssue(args.slice(1), env, fetcher);
  if (command === "status") return await getIssue(args.slice(1), env, fetcher);
  if (command === "update") return await updateIssue(args.slice(1), env, fetcher);
  if (command === "logs") return await getIssueLogs(args.slice(1), env, fetcher);
  if (command === "retry" || command === "cancel" || command === "enqueue") return await issueAction(command, args.slice(1), env, fetcher);
  if (REVIEW_ACTIONS.has(command)) return await verificationAction(command, args.slice(1), env, fetcher);
  if (command === "verification") return await reviewIssue(args.slice(1), env, fetcher);
  throw new Error(`unknown issue command: ${command}`);
}

async function createIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...CREATE_FLAGS], env);
  const body = await issueBody(values.body ?? "", values["body-file"] ?? "");
  const payload = createPayload(values, env, body);
  let issue = await postJSON<IssueDTO>(fetcher, common, "/api/issues", payload);
  if (values.run === "true") {
    issue = await postJSON<IssueDTO>(fetcher, common, `/api/issues/${issue.id}/enqueue`, {});
  }
  return formatIssue(issue, common.json);
}

async function getIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const issue = await getJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(values.id)}`);
  return formatIssue(issue, common.json);
}

async function updateIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...UPDATE_FLAGS], env);
  const payload = updatePayload(values.status ?? "", values.error ?? "");
  if (Object.keys(payload).length === 0) throw new Error("--status or --error is required");
  const issue = await patchJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(values.id)}`, payload);
  return formatIssue(issue, common.json);
}

async function getIssueLogs(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const events = await getJSON<IssueEventDTO[]>(fetcher, common, `/api/issues/${issueID(values.id)}/events`);
  return formatIssueEvents(events, common.json);
}

async function issueAction(action: string, args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const issue = await postJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(values.id)}/${action}`, {});
  return formatIssue(issue, common.json);
}

async function verificationAction(action: string, args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [{ name: "id", required: true }, { name: "comment" }], env);
  return await postVerification(fetcher, common, values.id, action, values.comment ?? "");
}

async function reviewIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...REVIEW_FLAGS], env);
  return await postVerification(fetcher, common, values.id, values.action, values.comment ?? "");
}

async function postVerification(
  fetcher: Fetcher,
  common: Parameters<typeof postJSON<IssueDTO>>[1],
  id: string,
  action: string,
  comment: string
): Promise<string> {
  const review = { action: normalizeReviewAction(action), comment: comment.trim() };
  const issue = await postJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(id)}/verification`, review);
  return formatIssue(issue, common.json);
}

function createPayload(values: Record<string, string>, env: EnvReader, body: string): Record<string, unknown> {
  const title = (values.title ?? "").trim();
  if (title === "" && body === "") throw new Error("--title or --body/--body-file is required");
  return {
    project_id: values.project,
    title,
    description: body,
    status: values.status || "triage",
    priority: integerValue(values.priority, "--priority"),
    template_id: values.template ?? "",
    source_session_id: values["source-session"] ?? env("CODEX_THREAD_ID") ?? "",
    source_turn_id: values["source-turn"] ?? env("CODEX_TURN_ID") ?? "",
    source_excerpt: values["source-excerpt"] ?? ""
  };
}

function updatePayload(status: string, error: string): Record<string, string> {
  const payload: Record<string, string> = {};
  const cleanStatus = status.trim();
  const cleanError = error.trim();
  if (cleanStatus !== "") {
    payload.status = cleanStatus;
    if (cleanStatus !== "failed") payload.error = "";
  }
  if (cleanError !== "") payload.error = cleanError;
  return payload;
}

async function issueBody(body: string, bodyFile: string): Promise<string> {
  if (bodyFile.trim() === "") return body.trim();
  return (await readFile(bodyFile, "utf8")).trim();
}

function issueID(value: string): string {
  const id = value.trim();
  if (!/^[0-9]+$/.test(id) || Number(id) <= 0) throw new Error("issue id 不合法");
  return id;
}

function integerValue(value: string | undefined, label: string): number {
  const text = value?.trim() ?? "";
  if (text === "") return 0;
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function normalizeReviewAction(action: string): string {
  const normalized = action.trim().replaceAll("_", "-");
  if (normalized === "accept" || normalized === "reject" || normalized === "request-changes") {
    return normalized.replaceAll("-", "_");
  }
  throw new Error("verification action 必须是 accept、reject 或 request_changes");
}
