import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detailSource = readFileSync(new URL('./RunDetail.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../api/runs.js', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./runDetailModel.js', import.meta.url), 'utf8');

const runsPageSource = readFileSync(new URL('../Runs.jsx', import.meta.url), 'utf8');

test('Run Detail exposes four decision-oriented sections and hides a single Attempt selector', () => {
  for (const label of ['Summary', 'Logs', 'Evidence', 'Advanced']) {
    assert.match(detailSource, new RegExp(`label: '${label}'`));
  }
  for (const label of ['Approvals', 'Provider session']) {
    assert.doesNotMatch(detailSource, new RegExp(`label: '${label}'`));
  }
  assert.match(detailSource, /aria-label="Run attempts"/);
  assert.match(detailSource, /attempts\.length > 1/);
  assert.match(detailSource, />Timeline</);
  assert.match(detailSource, />Cost</);
  assert.match(detailSource, /Advanced raw events/);
  assert.match(detailSource, /<EvidencePanel runId=\{run\.id\}/);
});

test('provider observation is a secondary context action instead of a fixed detail tab', () => {
  assert.match(runsPageSource, /Provider session/);
  assert.match(runsPageSource, /navigateTo\?\.\('sessions', null, providerSessionRef\)/);
  assert.doesNotMatch(detailSource, /<Sessions|ProviderSessionDrillDown|useRunApprovals/);
  assert.doesNotMatch(detailSource, /interruptSession\(/);
  assert.doesNotMatch(detailSource, /sendSessionMessage\(/);
});

test('logs and raw events reuse bounded existing APIs instead of expanding the Run contract', () => {
  assert.match(apiSource, /request\(`\/api\/issues\/\$\{encodeURIComponent\(issueId\)\}\/events\?/);
  assert.doesNotMatch(apiSource, /getRunApprovals|approval-requests/);
  assert.match(modelSource, /RUN_EVENT_PAGE_SIZE = 100/);
  assert.match(modelSource, /RUN_EVENT_SCAN_LIMIT = 500/);
  assert.match(detailSource, /interactive cap \{RUN_EVENT_SCAN_LIMIT\}/);
});
