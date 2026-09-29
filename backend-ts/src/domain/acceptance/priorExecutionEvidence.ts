import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueRuns } from "../../db/repositories/issues.ts";
import { readIssueRunGitWorkspaceBaseline } from "../evidence/runGitWorkspaceBaseline.ts";
import { observeGitWorkspaceBaseline } from "../run/gitWorkspaceObservation.ts";
import { assertCompletionCardIntegrity, COMPLETION_CARD_EVENT_TYPE, COMPLETION_GIT_OBSERVATION_CONTRACT, COMPLETION_GIT_OBSERVATION_EVENT_TYPE,
  type CompletionCard, type CompletionCardCommand } from "./completionCard.ts";
import { captureExecutionEvidenceContext, EXECUTION_EVIDENCE_CONTEXT_EVENT, stableJson,
  type ExecutionEvidenceContext } from "./executionEvidenceContext.ts";
import { sameObservedCommand } from "./observedCommand.ts";

export const EXECUTION_EVIDENCE_REVOKED_EVENT = "issue.execution_evidence_revoked.v1";
const HISTORY_LIMIT = 24;
const COMMAND_LIMIT = 72;
export type PriorExecutionEvidence = {
  items: Array<{
    source_run_id: string;
    source_card_fingerprint: string;
    source_event_ref: string;
    context_refs: string[];
    scope: "repository_and_host";
    commands: CompletionCardCommand[];
    status: "reusable" | "revalidation_required";
    reasons: string[];
    revalidation_commands: string[];
  }>;
  omitted_cards: number;
  unavailable_sources: Array<{ source_event_ref: string; reason: string }>;
};
type CardFacts = Pick<CompletionCard, "issue" | "run" | "git" | "commands">;
type Snapshot = { revision: string; hash: string };

/** 只从账本读原始观察，绝不递归继承某张旧卡片的复用结论。 */
export async function buildPriorExecutionEvidence(db: RunnerDatabase, current: CardFacts): Promise<PriorExecutionEvidence> {
  const history = sourceCards(db, current);
  if (!history.items.length) return { items: [], omitted_cards: history.omitted, unavailable_sources: history.unavailable };
  const context = captureExecutionEvidenceContext(db, current.issue.id);
  const live = context ? await observeGitWorkspaceBaseline({ project_cwd: context.repository, run_id: current.run.id }).catch(() => null) : null;
  return evaluate(db, current, history, context, live ? { revision: live.base_revision, hash: live.snapshot_sha256 } : null);
}

export async function assertPriorExecutionEvidenceFresh(db: RunnerDatabase, card: CompletionCard): Promise<void> {
  if (!card.prior_evidence?.items.some(item => item.status === "reusable")) return;
  const current = await buildPriorExecutionEvidence(db, card);
  if (stableJson(current) !== stableJson(card.prior_evidence)) throw new Error("Prior execution evidence changed; rebuild completion card and revalidate");
}

export function assertPriorEvidenceReferences(card: CompletionCard, decision: {
  decision: string; evidence_refs: string[]; progress: { evidence_refs: string[] }
}): void {
  for (const source of card.prior_evidence?.items ?? []) {
    const refs = new Set([source.source_event_ref, `completion-card:${source.source_card_fingerprint}`,
      `run:${source.source_run_id}`, `xw:run:issue_runs:${source.source_run_id}`,
      ...source.commands.flatMap(command => [
        `command:${source.source_run_id}:${command.id}`, ...(command.source_event_ref ? [command.source_event_ref] : [])
      ])]);
    if (decision.progress.evidence_refs.some(ref => refs.has(ref))) {
      throw new Error("Prior execution evidence is not current Run progress");
    }
    if (decision.decision === "accept" && source.status !== "reusable" && decision.evidence_refs.some(ref => refs.has(ref))) {
      throw new Error(`Prior execution evidence requires revalidation: ${source.reasons.join(", ")}`);
    }
  }
}

// 在提交验收事务内再次检查撤回、输入及环境；文件观察在事务外完成。
export function assertPriorExecutionEvidenceLedgerFresh(db: RunnerDatabase, card: CompletionCard): void {
  if (!card.prior_evidence?.items.some(item => item.status === "reusable")) return;
  const actual = evaluate(db, card, sourceCards(db, card), captureExecutionEvidenceContext(db, card.issue.id), terminalSnapshot(db, card));
  if (stableJson(actual) !== stableJson(card.prior_evidence)) throw new Error("Prior execution evidence ledger changed; rebuild completion card and revalidate");
}

function sourceCards(db: RunnerDatabase, current: CardFacts) {
  const rows = db.sqlite.query<{ id: number; payload: string }, [number, string, string, number]>(`
    select id,payload from issue_events where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload,'$.card.run.id')<>? order by id desc limit ?
  `).all(current.issue.id, COMPLETION_CARD_EVENT_TYPE, current.run.id, HISTORY_LIMIT + 1);
  const seen = new Set<string>();
  const cards: CompletionCard[] = [];
  const unavailable: PriorExecutionEvidence["unavailable_sources"] = [];
  let commandCount = 0;
  let omitted = Math.max(0, rows.length - HISTORY_LIMIT);
  const items = rows.slice(0, HISTORY_LIMIT).flatMap(row => {
    try {
      const card = JSON.parse(row.payload).card;
      if (typeof card?.run?.id === "string") {
        if (seen.has(card.run.id)) return [];
        seen.add(card.run.id);
      }
      assertCompletionCardIntegrity(card);
      if (!card.commands.items.every(command => command && typeof command.command === "string" &&
        typeof command.cwd === "string" && Number.isInteger(command.exit_code) && Number.isFinite(Date.parse(command.observed_at)))) {
        throw new Error("invalid command observation");
      }
      cards.push(card);
      if (commandCount + card.commands.items.length > COMMAND_LIMIT) { omitted += 1; return []; }
      commandCount += card.commands.items.length;
      return card.commands.items.length ? [{ card, eventID: row.id }] : [];
    } catch {
      unavailable.push({ source_event_ref: `event:${row.id}`, reason: "source_card_invalid; inspect ledger and revalidate" });
      return [];
    }
  });
  return { items, omitted, cards, unavailable };
}

function evaluate(db: RunnerDatabase, current: CardFacts, history: ReturnType<typeof sourceCards>,
  liveContext: ExecutionEvidenceContext | null, liveSnapshot: Snapshot | null): PriorExecutionEvidence {
  const runs = listIssueRuns(db, current.issue.id);
  const currentSnapshot = terminalSnapshot(db, current);
  const currentContext = runContext(db, current.issue.id, current.run.id);
  return { omitted_cards: history.omitted, unavailable_sources: history.unavailable, items: history.items.map(({ card: source, eventID }) => {
    const reasons: string[] = [];
    const prior = runs.find(run => run.id === source.run.id);
    const snapshot = terminalSnapshot(db, source);
    const context = runContext(db, current.issue.id, source.run.id);
    if (source.issue.id !== current.issue.id || source.issue.project_id !== current.issue.project_id ||
      !prior || prior.attempt >= current.run.attempt || !prior.ended_at || prior.ended_at !== source.run.ended_at ||
      // Run started_at 的历史写入精度为秒，ended_at 可以带毫秒；attempt 是同秒内的权威顺序。
      Math.floor(Date.parse(prior.ended_at) / 1000) > Math.floor(Date.parse(current.run.started_at) / 1000)) reasons.push("source_work_or_run_mismatch");
    if (!snapshot || !currentSnapshot || !liveSnapshot) reasons.push("code_snapshot_unavailable");
    else if (!sameSnapshot(snapshot, currentSnapshot) || !sameSnapshot(currentSnapshot, liveSnapshot)) reasons.push("code_snapshot_changed");
    // 没有命令级快照时，不把 Run 内修改之前的测试冒充修改后的验证。
    for (const card of [source, current]) {
      const baseline = readIssueRunGitWorkspaceBaseline(db, current.issue.id, card.run.id);
      const end = terminalSnapshot(db, card);
      if (!baseline || !end || !sameSnapshot({ revision: baseline.base_revision, hash: baseline.snapshot_sha256 }, end)) {
        reasons.push(card === source ? "source_command_snapshot_unconfirmed" : "current_run_changed_snapshot");
      }
    }
    if (!context.value || !currentContext.value || !liveContext) reasons.push("execution_conditions_unavailable");
    else {
      if (context.value.project_id !== current.issue.project_id || context.value.work_id !== `xw:work:issues:${current.issue.id}` ||
        currentContext.value.project_id !== current.issue.project_id || currentContext.value.work_id !== context.value.work_id) reasons.push("source_work_or_run_mismatch");
      if (context.value.input_fingerprint !== currentContext.value.input_fingerprint ||
        currentContext.value.input_fingerprint !== liveContext.input_fingerprint) reasons.push("inputs_changed");
      if (context.value.repository !== currentContext.value.repository || currentContext.value.repository !== liveContext.repository ||
        context.value.environment_fingerprint !== currentContext.value.environment_fingerprint ||
        currentContext.value.environment_fingerprint !== liveContext.environment_fingerprint || source.run.provider !== current.run.provider) reasons.push("environment_changed");
    }
    if (source.commands.omitted > 0 || source.commands.total !== source.commands.items.length ||
      source.commands.items.some(command => Buffer.byteLength(command.command) >= 2000)) reasons.push("source_commands_incomplete");
    if (source.commands.items.some(command => command.source_run_id !== source.run.id || !command.source_event_ref)) {
      reasons.push("source_command_binding_unconfirmed");
    }
    if (runs.some(run => run.attempt > source.run.attempt && run.attempt < current.run.attempt &&
      !history.cards.some(card => card.run.id === run.id && card.issue.id === current.issue.id &&
        card.issue.project_id === current.issue.project_id && card.commands.omitted === 0))) reasons.push("intervening_run_unconfirmed");
    const revoked = db.sqlite.query<{ id: number }, [number, string, string, string]>(`
      select id from issue_events where issue_id=? and type=? and json_valid(payload)
        and (json_extract(payload,'$.source_run_id')=? or json_extract(payload,'$.source_card_fingerprint')=?) limit 1
    `).get(current.issue.id, EXECUTION_EVIDENCE_REVOKED_EVENT, source.run.id, source.fingerprint);
    if (revoked) reasons.push(`evidence_revoked:event:${revoked.id}`);
    const later = [current, ...history.cards.filter(card => card.run.attempt > source.run.attempt)];
    if (source.commands.items.some(command => later.some(card => card.commands.items.some(item =>
      sameObservedCommand(item.command, command.command) &&
      resolve(liveContext?.repository ?? "/", item.cwd) === resolve(liveContext?.repository ?? "/", command.cwd) &&
      item.exit_code !== command.exit_code)))) reasons.push("superseded_command_result");
    const unique = [...new Set(reasons)];
    return { source_run_id: source.run.id, source_card_fingerprint: source.fingerprint, source_event_ref: `event:${eventID}`,
      context_refs: [...context.refs, ...currentContext.refs], scope: "repository_and_host" as const,
      commands: source.commands.items, status: unique.length ? "revalidation_required" as const : "reusable" as const,
      reasons: unique, revalidation_commands: unique.length ? [...new Set(source.commands.items.map(item => item.command))] : [] };
  }) };
}

function runContext(db: RunnerDatabase, issueID: number, runID: string): { value: ExecutionEvidenceContext | null; refs: string[] } {
  const rows = db.sqlite.query<{ id: number; payload: string }, [number, string, string]>(`
    select id,payload from issue_events where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload,'$.run_id')=? order by id
  `).all(issueID, EXECUTION_EVIDENCE_CONTEXT_EVENT, runID);
  const observations = rows.map(row => ({ id: row.id, ...JSON.parse(row.payload) }));
  const start = observations.find(row => row.phase === "start");
  const terminal = [...observations].reverse().find(row => row.phase === "terminal");
  const refs = [start, terminal].filter(Boolean).map(row => `event:${row.id}`);
  const value = start?.context;
  if (!value || value.scope !== "repository_and_host" || !/^[a-f0-9]{64}$/.test(value.input_fingerprint) ||
    !/^[a-f0-9]{64}$/.test(value.environment_fingerprint) || stableJson(value) !== stableJson(terminal?.context)) return { value: null, refs };
  return { value, refs };
}

function terminalSnapshot(db: RunnerDatabase, card: CardFacts): Snapshot | null {
  const row = db.sqlite.query<{ payload: string }, [number, string, string]>(`
    select payload from issue_events where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload,'$.observation.run_id')=? order by id desc limit 1
  `).get(card.issue.id, COMPLETION_GIT_OBSERVATION_EVENT_TYPE, card.run.id);
  if (!row || card.git.source !== "terminal_observation") return null;
  const observation = JSON.parse(row.payload).observation;
  if (observation.contract !== COMPLETION_GIT_OBSERVATION_CONTRACT) return null;
  const snapshot = observation.workspace_snapshot;
  if (!snapshot || !Array.isArray(snapshot.entries) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(snapshot.base_revision)) return null;
  const hash = createHash("sha256").update(`${JSON.stringify(snapshot.entries)}\n`).digest("hex");
  if (hash !== snapshot.snapshot_sha256 || snapshot.base_revision !== observation.final_revision ||
    observation.final_revision !== card.git.final_revision || card.git.workspace_snapshot_ref !== `run-git-snapshot:${card.run.id}:${hash}`) return null;
  return { revision: snapshot.base_revision, hash };
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean { return a.revision === b.revision && a.hash === b.hash; }
