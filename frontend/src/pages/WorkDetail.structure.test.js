import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detail = readFileSync(new URL('./WorkDetail.jsx', import.meta.url), 'utf8');
const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const model = readFileSync(new URL('./workDetailModel.js', import.meta.url), 'utf8');

test('Work Detail keeps two task-oriented views and loads Activity only on demand', () => {
  assert.match(detail, />Overview</);
  assert.match(detail, />Activity</);
  assert.match(detail, /workApi\.getWork\(workId\)/);
  assert.match(detail, /workApi\.getWorkTimeline/);
  assert.match(detail, /runsApi\.getRuns/);
  assert.match(detail, /evidenceApi\.listEvidence/);
  assert.match(detail, /handoffsApi\.getHandoffs/);
  assert.match(detail, /activeView === 'activity' && !activityLoaded/);
  assert.doesNotMatch(detail, /getWorkRelations|readiness|relationship|guardianAlerts|compatibility/);
  assert.doesNotMatch(detail, /<EvidencePanel/);
});

test('Work Board stays board-only and opens canonical Work Detail', () => {
  assert.doesNotMatch(board, /onViewChange|WorkList|work-view-toggle/);
  assert.match(board, /WORK_BOARD_STATUSES\.map\(status =>/);
  assert.match(board, /navigateTo\('work', work\.id\)/);
  assert.doesNotMatch(board, /navigateTo\('issues', issueId\)/);
  assert.match(board, /Issue #\{issueId\} authority/);
  assert.match(board, /<WorkDetail/);
  assert.doesNotMatch(board, /relations=|work-relation-row|indexRelationsByWork/);
});

test('Work Detail mutations use audited Work controls and the existing verification gate', () => {
  assert.match(detail, /workApi\.controlWork\(work\.id, action, buildWorkActionPayload\(work, action\)\)/);
  assert.match(detail, /workApi\.reviewWork\(work\.id/);
  assert.match(model, /expected_revision/);
  assert.doesNotMatch(detail, /window\.(alert|confirm)/);
});
