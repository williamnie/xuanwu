import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detail = readFileSync(new URL('./WorkDetail.jsx', import.meta.url), 'utf8');
const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const model = readFileSync(new URL('./workDetailModel.js', import.meta.url), 'utf8');

test('Work Detail composes canonical sections without replacing existing domain clients', () => {
  for (const section of ['acceptance', 'relationships', 'attention', 'runs', 'evidence', 'handoffs', 'timeline']) {
    assert.match(detail, new RegExp(`id="work-${section}"`));
  }
  assert.match(detail, /workApi\.getWork\(workId\)/);
  assert.match(detail, /workApi\.getWorkTimeline/);
  assert.match(detail, /runsApi\.getRuns/);
  assert.match(detail, /<EvidencePanel title="Work Evidence" workId=\{work\.id\} \/>/);
  assert.match(detail, /handoffsApi\.getHandoffs/);
  assert.match(detail, /assistantApi\.getPiGuardianAlerts/);
});

test('Work Board offers board/list views, opens Work Detail, and retains Issue compatibility deep link', () => {
  assert.match(board, /onViewChange\('board'\)/);
  assert.match(board, /onViewChange\('list'\)/);
  assert.match(board, /navigateTo\('work', work\.id\)/);
  assert.match(board, /navigateTo\('issues', issueId\)/);
  assert.match(board, /<WorkDetail/);
});

test('Work Detail mutations use audited Work controls and the existing verification gate', () => {
  assert.match(detail, /workApi\.controlWork\(work\.id, action, buildWorkActionPayload\(work, action\)\)/);
  assert.match(detail, /workApi\.reviewWork\(work\.id/);
  assert.match(model, /expected_revision/);
  assert.doesNotMatch(detail, /window\.(alert|confirm)/);
});
