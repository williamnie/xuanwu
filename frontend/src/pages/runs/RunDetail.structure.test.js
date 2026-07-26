import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detailSource = readFileSync(new URL('./RunDetail.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../api/runs.js', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./runDetailModel.js', import.meta.url), 'utf8');

const runsPageSource = readFileSync(new URL('../Runs.jsx', import.meta.url), 'utf8');

test('Run Detail puts Provider first and hides a single Attempt selector', () => {
  for (const label of ['Provider', 'Summary', 'Logs', 'Evidence', 'Advanced']) {
    assert.match(detailSource, new RegExp(`label: '${label}'`));
  }
  assert.ok(detailSource.indexOf("label: 'Provider'") < detailSource.indexOf("label: 'Summary'"));
  assert.doesNotMatch(detailSource, /label: 'Approvals'/);
  assert.match(detailSource, /aria-label="Run attempts"/);
  assert.match(detailSource, /attempts\.length > 1/);
  assert.match(detailSource, />Timeline</);
  assert.match(detailSource, />Cost</);
  assert.match(detailSource, /Advanced raw events/);
  assert.match(detailSource, /<EvidencePanel runId=\{run\.id\}/);
});

test('provider observation is an embedded primary tab without duplicate Evidence', () => {
  assert.match(detailSource, /<Sessions/);
  assert.match(detailSource, /ProviderSessionDrillDown/);
  assert.match(detailSource, /showEvidence=\{false\}/);
  assert.doesNotMatch(detailSource, /useRunApprovals/);
  assert.doesNotMatch(detailSource, /interruptSession\(/);
  assert.doesNotMatch(detailSource, /sendSessionMessage\(/);
  assert.doesNotMatch(runsPageSource, /> Provider session/);
});

test('logs and raw events reuse bounded existing APIs instead of expanding the Run contract', () => {
  assert.match(apiSource, /request\(`\/api\/issues\/\$\{encodeURIComponent\(issueId\)\}\/events\?/);
  assert.doesNotMatch(apiSource, /getRunApprovals|approval-requests/);
  assert.match(modelSource, /RUN_EVENT_PAGE_SIZE = 100/);
  assert.match(modelSource, /RUN_EVENT_SCAN_LIMIT = 500/);
  assert.match(detailSource, /interactive cap \{RUN_EVENT_SCAN_LIMIT\}/);
});
