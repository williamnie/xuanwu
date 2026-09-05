import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../db/database.ts';
import { createIssue } from '../../db/repositories/issueCreate.ts';
import { recordIssueEvent } from '../../db/repositories/issueEvents.ts';
import { recordEvidenceRecords } from '../../db/repositories/evidence.ts';
import { createCommandEvidenceCollector } from '../evidence/commandCollector.ts';
import { recordPiRecoveryAttempt } from '../../db/repositories/pi/recoveryAttempts.ts';
import { createPiNotificationIntent } from '../../db/repositories/pi.ts';
import { completeFirstDelivery } from './firstDelivery.ts';
import { createDefaultRouter } from '../../http/server.ts';
import { buildDeliveryEffectiveness } from '../../observability/deliveryEffectiveness.ts';

const now = '2026-09-05T04:00:00.000Z';
test('first delivery requires an audited sample and real evidence, persists once, and leaves Git unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xw-first-delivery-'));
  const db = await openDatabase({ stateDir: join(root, 'state') });
  const repo = join(root, 'repo');
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', repo, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  try {
    await mkdir(repo);
    git(['init', '-q']);
    await writeFile(join(repo, 'README.md'), 'test repository\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial']);
    db.sqlite.run(`insert into projects (id,name,cwd,created_at,updated_at) values ('demo','Demo',?,?,?)`, [repo, now, now]);
    const issue = createIssue(db, { project_id: 'demo', title: '玄武首次交付：只读项目体检', status: 'done' });
    await expect(completeFirstDelivery(db, issue.id)).rejects.toThrow('首启引导');
    recordIssueEvent(db, issue.id, 'issue.created', { actor: { id: 'first-delivery-guide', kind: 'user' } });
    db.sqlite.run(`insert into issue_runs (id,issue_id,attempt,status,started_at,ended_at) values ('sample-run',?,1,'succeeded',?,?)`, [issue.id, '2026-09-05T03:59:00.000Z', now]);
    await expect(completeFirstDelivery(db, issue.id)).rejects.toThrow('验证记录');
    const workID = `xw:work:issues:${issue.id}` as const;
    const output = Bun.spawnSync(['printf', 'Hello Xuanwu\n'], { cwd: repo });
    const evidence = await createCommandEvidenceCollector().collect({
      kind: 'shell', observation: {
        command: "printf 'Hello Xuanwu\\n'", cwd: repo, exit_code: output.exitCode,
        stdout: output.stdout.toString(), stderr: output.stderr.toString(),
        started_at: now, ended_at: now, duration_ms: 0,
      },
      context: { evidence_id: 'xw:evidence:issue_events:sample-command', work_id: workID,
        run_id: 'xw:run:issue_runs:sample-run', producer: { kind: 'runner', id: 'fixture' },
        audit_event_ref: 'fixture-command', source_ref: 'fixture-command', collected_at: now },
    });
    recordEvidenceRecords(db, issue.id, [evidence], { recorded_at: now, source: 'fixture-command' });
    const head = git(['rev-parse', 'HEAD']);
    const [first, replay] = await Promise.all([completeFirstDelivery(db, issue.id), completeFirstDelivery(db, issue.id)]);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
    const router = createDefaultRouter({ database: db });
    const response = await router.handle(new Request(`http://localhost/api/onboarding/works/${encodeURIComponent(workID)}/delivery-check`, { method: 'POST' }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ created: false, handoff: { id: first.handoff.id } });
    expect(first.handoff.changed_files).toEqual([]);
    expect(first.handoff.evidence_ids).toContain(evidence.id);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    const metric = buildDeliveryEffectiveness(db, new Date('2026-09-05T05:00:00.000Z'));
    expect(metric).toMatchObject({ sampled_works: 1, delivered_works: 1, without_help_delivery_rate: 1,
      cost: { known_works: 0, unknown_works: 1 }, duration: { median_ms: 60000 } });
    createPiNotificationIntent(db, { idempotency_key: 'sample-help', issue_id: issue.id, kind: 'needs_user', requires_user: 1 });
    for (const id of ['recovery-1', 'recovery-2']) recordPiRecoveryAttempt(db, {
      id, idempotency_key: id, issue_id: issue.id, project_id: 'demo', action_type: 'session.resume_followup',
      diagnosis_code: 'test', status: 'no_progress', budget_window_started_at: now,
    });
    db.sqlite.run(`update run_attempts set cost_json=?`, [JSON.stringify({ money: { currency: 'USD', amount_micros: 0 } })]);
    const afterHelp = buildDeliveryEffectiveness(db, new Date('2026-09-05T05:00:00.000Z'));
    expect(afterHelp).toMatchObject({ without_help_delivery_rate: 0, help_requested_works: 1,
      recovery: { works: 1, delivered_works: 1, delivery_rate: 1, no_progress_attempts: 2, repeated_no_progress_works: 1 },
      cost: { known_works: 1, unknown_works: 0, by_currency: [{ currency: 'USD', mean_micros: 0 }] } });
    db.sqlite.run(`insert into issue_runs (id,issue_id,attempt,status,started_at,ended_at) values ('new-run',?,2,'succeeded',?,?)`, [issue.id, now, now]);
    expect(buildDeliveryEffectiveness(db, new Date('2026-09-05T05:00:00.000Z'))).toMatchObject({
      delivered_works: 0, cost: { unknown_works: 1, known_works: 0 },
    });
    expect(buildDeliveryEffectiveness(db, new Date('2026-11-05T05:00:00.000Z'))).toMatchObject({
      sampled_works: 0, delivery_rate: null, duration: { median_ms: null },
    });
    db.sqlite.run(`update issues set status='in_progress' where id=?`, [issue.id]);
    await expect(completeFirstDelivery(db, issue.id)).rejects.toThrow('尚未完成');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
