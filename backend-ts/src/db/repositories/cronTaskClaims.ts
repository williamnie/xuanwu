import type { RunnerDatabase } from "../database.ts";
import type { CronTask } from "./cronTasks.ts";
import { listCronTasks } from "./cronTasks.ts";

export type ClaimedCronTask = CronTask & { claim_started_at: string; claim_token: string };

type IDRow = { id: number };

export function claimDueCronTasks(db: RunnerDatabase, now: Date): ClaimedCronTask[] {
  const nowText = now.toISOString();
  const token = crypto.randomUUID();
  const claim = db.transaction((timestamp: string, claimToken: string) => {
    const ids = dueCronIDs(db, timestamp);
    if (ids.length === 0) return [];
    markClaimed(db, ids, timestamp, claimToken);
    return claimedTasks(db, claimToken, timestamp);
  });
  return claim.immediate(nowText, token);
}

function dueCronIDs(db: RunnerDatabase, nowText: string): number[] {
  return db.sqlite.query<IDRow, [string]>(`
    select id from cron_tasks
    where status='active' and next_run_at<>'' and next_run_at<=? and claim_token=''
    order by next_run_at asc, created_at asc, id asc
  `).all(nowText).map((row) => row.id);
}

function markClaimed(db: RunnerDatabase, ids: number[], nowText: string, token: string): void {
  const placeholders = ids.map(() => "?").join(",");
  db.sqlite.run(`update cron_tasks set claim_token=?, claim_started_at=?, updated_at=?
    where id in (${placeholders}) and status='active' and next_run_at<>'' and next_run_at<=?
      and claim_token=''`, [token, nowText, nowText, ...ids, nowText]);
}

function claimedTasks(db: RunnerDatabase, token: string, nowText: string): ClaimedCronTask[] {
  const rows = db.sqlite.query<IDRow, [string]>(`
    select id from cron_tasks where claim_token=?
    order by next_run_at asc, created_at asc, id asc
  `).all(token);
  const tasks = new Map(listCronTasks(db).map((task) => [task.id, task]));
  return rows.flatMap((row) => {
    const task = tasks.get(row.id);
    return task ? [{ ...task, claim_token: token, claim_started_at: nowText }] : [];
  });
}
