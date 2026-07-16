import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceListPath } from '../api/evidence.js';
import {
  decisiveEvidence,
  decisiveEvidenceText,
  evidenceScopeLabel,
  evidenceStatusMeta,
  mergeEvidencePages,
} from './evidencePresentation.js';

test('Evidence list query keeps Work, Run and session scopes explicit and encoded', () => {
  const path = evidenceListPath({
    cursor: 'opaque cursor',
    limit: 10,
    runId: 'xw:run:issue_runs:issue-7-attempt-1',
    sessionRef: 'codex:thread/7',
    workId: 'xw:work:issues:7',
  });
  assert.match(path, /^\/api\/evidence\?/);
  const params = new URL(`http://runner.test${path}`).searchParams;
  assert.equal(params.get('cursor'), 'opaque cursor');
  assert.equal(params.get('run_id'), 'xw:run:issue_runs:issue-7-attempt-1');
  assert.equal(params.get('session_ref'), 'codex:thread/7');
  assert.equal(params.get('work_id'), 'xw:work:issues:7');
  assert.equal(params.get('limit'), '10');
});

test('failed or blocked Evidence remains decisive over a passed Agent run', () => {
  const items = [
    evidence('passed', 'tests passed', 0),
    evidence('failed', 'API smoke returned 500', 1),
  ];
  const decisive = decisiveEvidence(items);
  assert.equal(decisive.id, 'evidence-failed');
  assert.equal(decisiveEvidenceText(decisive), '未通过：API smoke returned 500');
  assert.deepEqual(evidenceStatusMeta('failed'), { label: 'Failed', tone: 'failed' });
  assert.equal(evidenceScopeLabel(decisive), 'test · exit 1 · Attempt 2');
});

test('pagination merge deduplicates Evidence by canonical id', () => {
  assert.deepEqual(mergeEvidencePages(
    [evidence('passed', 'old summary', 0)],
    [evidence('passed', 'fresh summary', 0), evidence('blocked', 'missing browser', null)],
  ).map(item => [item.id, item.decisive_summary]), [
    ['evidence-passed', 'fresh summary'],
    ['evidence-blocked', 'missing browser'],
  ]);
});

function evidence(status, summary, exitCode) {
  return {
    attempt_id: 'xw:run:issue_runs:issue-7-attempt-1~attempt:2',
    decisive_summary: summary,
    exit_code: exitCode,
    id: `evidence-${status}`,
    kind: 'test',
    status,
  };
}
