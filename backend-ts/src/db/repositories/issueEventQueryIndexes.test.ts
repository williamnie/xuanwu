import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import {
  EVIDENCE_RECORDED_EVENT_TYPE,
  LEGACY_HUMAN_EVIDENCE_EVENT_TYPE
} from "./evidence.ts";
import { HANDOFF_RECORD_EVENT_TYPES } from "./handoffs.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue Event query indexes", () => {
  test("uses the global type/id index for every P0 point lookup and replay shape", async () => {
    const db = await openFixture();
    try {
      const lifecycle = plan(db, `
        select id, payload from issue_events
        where type=? and json_valid(payload) and json_extract(payload, '$.attempt_id')=?
        order by id desc limit 1
      `, ["run.lifecycle.intent.v1", "attempt-1"]);
      const usageBaseline = plan(db, `
        select id, payload from issue_events
        where type=? and json_valid(payload) and json_extract(payload, '$.attempt_id')=?
        order by id desc limit 1
      `, ["run.lifecycle.intent.v1", "attempt-1"]);
      const workCreateReplay = plan(db, `
        select issue_id, payload from issue_events
        where type='issue.created'
          and json_extract(case when json_valid(payload) then payload else '{}' end, '$.event_id')=?
        order by id asc limit 1
      `, ["work-create-1"]);
      const evidence = plan(db, `
        select id, payload from issue_events
        where type in (?, ?) and json_valid(payload)
          and json_extract(payload, '$.evidence.id')=?
        order by id desc limit 20
      `, [EVIDENCE_RECORDED_EVENT_TYPE, LEGACY_HUMAN_EVIDENCE_EVENT_TYPE, "evidence-1"]);
      const handoff = plan(db, `
        select id, payload from issue_events
        where type in (?, ?, ?, ?, ?) and json_valid(payload)
          and json_extract(payload, '$.handoff.id')=?
        order by id desc limit 20
      `, [...HANDOFF_RECORD_EVENT_TYPES, "handoff-1"]);
      const scopeAudit = plan(db, `
        select event.id from issue_events event
        join issue_runs run on run.run_id=json_extract(event.payload, '$.run_id')
        where event.type in (?, ?, ?, ?) and json_valid(event.payload)
          and event.issue_id<>run.issue_id
        order by event.id asc limit ?
      `, [
        "run.lifecycle.intent.v1",
        "run.lifecycle.outcome.v1",
        "run.lifecycle.run_materialized.v1",
        "run.lifecycle.run_requested.v1",
        20
      ]);

      for (const details of [lifecycle, usageBaseline, workCreateReplay, evidence, handoff, scopeAudit]) {
        expectUsesTypeIndex(details);
      }
    } finally {
      db.close();
    }
  });

  test("uses the type/id index on both sides of Evidence and Handoff anti-joins", async () => {
    const db = await openFixture();
    try {
      const evidenceList = plan(db, `
        select event.id, event.issue_id, event.type, event.payload, issue.project_id
        from issue_events event
        join issues issue on issue.id=event.issue_id
        where (event.type=? or (event.type=? and not exists (
          select 1 from issue_events structured
          where structured.type=? and json_valid(structured.payload)
            and json_extract(structured.payload, '$.evidence.id')=json_extract(event.payload, '$.evidence.id')
        ))) and json_valid(event.payload)
        order by event.id desc limit ?
      `, [
        EVIDENCE_RECORDED_EVENT_TYPE,
        LEGACY_HUMAN_EVIDENCE_EVENT_TYPE,
        EVIDENCE_RECORDED_EVENT_TYPE,
        20
      ]);
      const placeholders = HANDOFF_RECORD_EVENT_TYPES.map(() => "?").join(", ");
      const handoffList = plan(db, `
        select event.id, event.type, event.issue_id, event.payload, issue.project_id
        from issue_events event
        join issues issue on issue.id=event.issue_id
        where event.type in (${placeholders}) and json_valid(event.payload)
          and not exists (
            select 1 from issue_events newer
            where newer.type in (${placeholders}) and json_valid(newer.payload)
              and json_extract(newer.payload, '$.handoff.id')=json_extract(event.payload, '$.handoff.id')
              and (
                cast(json_extract(newer.payload, '$.handoff.revision') as integer) >
                  cast(json_extract(event.payload, '$.handoff.revision') as integer)
                or (
                  cast(json_extract(newer.payload, '$.handoff.revision') as integer)=
                    cast(json_extract(event.payload, '$.handoff.revision') as integer)
                  and newer.id > event.id
                )
              )
          )
        order by event.id desc limit ?
      `, [...HANDOFF_RECORD_EVENT_TYPES, ...HANDOFF_RECORD_EVENT_TYPES, 20]);

      expectUsesTypeIndex(evidenceList, 2);
      expectUsesTypeIndex(handoffList, 2);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-issue-event-query-indexes-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function plan(db: RunnerDatabase, sql: string, args: Array<number | string>): string[] {
  return db.sqlite.query<{ detail: string }, Array<number | string>>(`explain query plan ${sql}`).all(...args)
    .map((row) => row.detail);
}

function expectUsesTypeIndex(details: string[], minimumUses = 1): void {
  expect(details.filter((detail) => detail.includes("idx_issue_events_type_id")).length)
    .toBeGreaterThanOrEqual(minimumUses);
  expect(details.filter((detail) => /\bSCAN (?:issue_events|event|request|structured|newer)\b/.test(detail) &&
    !detail.includes("USING INDEX"))).toEqual([]);
}
