import { readFile } from "node:fs/promises";
import { parseCommandArgs } from "./common.ts";
import { deleteJSON, getJSON, patchJSON, postJSON } from "./http.ts";
import { formatIssue, formatIssueEvents, formatJSON } from "./output.ts";
import type { EnvReader, Fetcher, IssueDTO, IssueEventDTO } from "./types.ts";

const CREATE_FLAGS = [
  { name: "project", required: true },
  { name: "title" },
  { name: "body" },
  { name: "body-file" },
  { name: "status" },
  { name: "priority" },
  { name: "agent-profile" },
  { name: "source-session" },
  { name: "source-turn" },
  { name: "source-excerpt" },
  { name: "required-skill" },
  { name: "recommended-skill" },
  { boolean: true, name: "run" }
] as const;

const UPDATE_FLAGS = [
  { name: "id", required: true },
  { name: "status" },
  { name: "error" },
  { name: "agent-profile" },
  { name: "title" },
  { name: "body" },
  { name: "body-file" },
  { name: "depends-on" },
  { boolean: true, name: "clear-dependencies" },
  { name: "required-skill" },
  { name: "recommended-skill" }
] as const;

const ID_FLAGS = [{ name: "id", required: true }] as const;
const REVIEW_FLAGS = [
  { name: "id", required: true },
  { name: "action", required: true },
  { name: "comment" }
] as const;

export async function runIssue(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const command = args[0]?.trim();
  if (!command) throw new Error("missing issue command");
  if (command === "create") return await createIssue(args.slice(1), env, fetcher);
  if (command === "status") return await getIssue(args.slice(1), env, fetcher);
  if (command === "update") return await updateIssue(args.slice(1), env, fetcher);
  if (command === "delete") return await deleteIssueCommand(args.slice(1), env, fetcher);
  if (command === "logs") return await getIssueLogs(args.slice(1), env, fetcher);
  if (command === "retry" || command === "cancel" || command === "enqueue") return await issueAction(command, args.slice(1), env, fetcher);
  if (command === "human-review") return await answerHumanReview(args.slice(1), env, fetcher);
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
  if (values.body !== undefined && values["body-file"] !== undefined) {
    throw new Error("--body and --body-file are mutually exclusive");
  }
  if (values["depends-on"] !== undefined && values["clear-dependencies"] === "true") {
    throw new Error("--depends-on and --clear-dependencies are mutually exclusive");
  }
  const description = values.body !== undefined || values["body-file"] !== undefined
    ? await issueBody(values.body ?? "", values["body-file"] ?? "")
    : undefined;
  const payload = updatePayload(values, description);
  if (Object.keys(payload).length === 0) {
    throw new Error("at least one issue update field is required");
  }
  const issue = await patchJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(values.id)}`, payload);
  return formatIssue(issue, common.json);
}

async function getIssueLogs(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const events = await getJSON<IssueEventDTO[]>(fetcher, common, `/api/issues/${issueID(values.id)}/events`);
  return formatIssueEvents(events, common.json);
}

async function deleteIssueCommand(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const id = issueID(values.id);
  await deleteJSON(fetcher, common, `/api/issues/${id}`);
  const summary = { deleted: true, id: Number(id) };
  return common.json ? formatJSON(summary) : `deleted issue #${id}\n`;
}

async function issueAction(action: string, args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...ID_FLAGS], env);
  const issue = await postJSON<IssueDTO>(fetcher, common, `/api/issues/${issueID(values.id)}/${action}`, {});
  return formatIssue(issue, common.json);
}

async function answerHumanReview(args: string[], env: EnvReader, fetcher: Fetcher): Promise<string> {
  const { common, values } = parseCommandArgs(args, [...REVIEW_FLAGS], env);
  return await postHumanReviewResponse(fetcher, common, values.id, values.action, values.comment ?? "");
}

async function postHumanReviewResponse(
  fetcher: Fetcher,
  common: Parameters<typeof postJSON<IssueDTO>>[1],
  id: string,
  action: string,
  comment: string
): Promise<string> {
  const issueIDValue = issueID(id);
  const current = await getJSON<IssueDTO>(fetcher, common, `/api/issues/${issueIDValue}`);
  const request = current.decision?.request;
  if (current.decision?.owner !== "human" || request?.status !== "open" || !request.id || !request.revision) {
    throw new Error("当前没有等待人类回答的问题；PI 仍负责自主判断或继续处理");
  }
  const review = {
    action: normalizeReviewAction(action),
    comment: comment.trim(),
    review_request_id: request.id,
    review_revision: request.revision
  };
  const issue = await postJSON<IssueDTO>(fetcher, common, `/api/issues/${issueIDValue}/human-review-response`, review);
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
    agent_profile_id: values["agent-profile"] ?? "",
    source_session_id: values["source-session"] ?? env("CODEX_THREAD_ID") ?? "",
    source_turn_id: values["source-turn"] ?? env("CODEX_TURN_ID") ?? "",
    source_excerpt: values["source-excerpt"] ?? "",
    required_skill_intents: intentList(values["required-skill"]),
    recommended_skill_intents: intentList(values["recommended-skill"])
  };
}

function updatePayload(values: Record<string, string>, description: string | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const cleanStatus = (values.status ?? "").trim();
  const cleanError = (values.error ?? "").trim();
  if (cleanStatus !== "") {
    payload.status = cleanStatus;
    if (cleanStatus !== "failed") payload.error = "";
  }
  if (cleanError !== "") payload.error = cleanError;
  if (values["agent-profile"] !== undefined) payload.agent_profile_id = values["agent-profile"];
  if (values.title !== undefined) payload.title = values.title;
  if (description !== undefined) payload.description = description;
  if (values["depends-on"] !== undefined) payload.depends_on_issue_ids = dependencyList(values["depends-on"]);
  if (values["clear-dependencies"] === "true") payload.depends_on_issue_ids = [];
  if ((values["required-skill"] ?? "").trim() !== "") {
    payload.required_skill_intents = intentList(values["required-skill"]);
  }
  if ((values["recommended-skill"] ?? "").trim() !== "") {
    payload.recommended_skill_intents = intentList(values["recommended-skill"]);
  }
  return payload;
}

function dependencyList(value: string): number[] {
  const tokens = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("--depends-on requires one or more positive Issue ids");
  const ids = tokens.map((item) => {
    if (!/^[1-9]\d*$/.test(item)) throw new Error("--depends-on must be a comma-separated list of positive Issue ids");
    const id = Number(item);
    if (!Number.isSafeInteger(id)) throw new Error("--depends-on must contain safe positive Issue ids");
    return id;
  });
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`--depends-on cannot repeat Issue #${duplicate}`);
  return ids;
}

async function issueBody(body: string, bodyFile: string): Promise<string> {
  if (bodyFile.trim() === "") return body.trim();
  return (await readFile(bodyFile, "utf8")).trim();
}

function intentList(value: string | undefined): string[] {
  return (value ?? "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
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
  throw new Error("human-review action 必须是 accept、reject 或 request_changes");
}
