import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detailSource = readFileSync(new URL('./RunDetail.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../api/runs.js', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./runDetailModel.js', import.meta.url), 'utf8');

test('Run Detail exposes summary, timeline, Attempts, logs, approvals, Evidence, cost, and raw events', () => {
  for (const label of ['Summary', 'Logs', 'Approvals', 'Evidence', 'Provider session', 'Advanced']) {
    assert.match(detailSource, new RegExp(`label: '${label}'`));
  }
  assert.match(detailSource, /aria-label="Run attempts"/);
  assert.match(detailSource, />Timeline</);
  assert.match(detailSource, />Cost</);
  assert.match(detailSource, /Advanced raw events/);
  assert.match(detailSource, /<EvidencePanel runId=\{run\.id\}/);
});

test('provider drill-down reuses Sessions as read-only observation while Run controls remain external', () => {
  assert.match(detailSource, /<Sessions/);
  assert.match(detailSource, /Provider session 仅用于低层观测与追溯/);
  assert.match(detailSource, /not Run authority/);
  assert.doesNotMatch(detailSource, /interruptSession\(/);
  assert.doesNotMatch(detailSource, /sendSessionMessage\(/);
});

test('logs and raw events reuse bounded existing APIs instead of expanding the Run contract', () => {
  assert.match(apiSource, /request\(`\/api\/issues\/\$\{encodeURIComponent\(issueId\)\}\/events\?/);
  assert.match(apiSource, /request\(`\/api\/pi\/approval-requests\?/);
  assert.match(modelSource, /RUN_EVENT_PAGE_SIZE = 100/);
  assert.match(modelSource, /RUN_EVENT_SCAN_LIMIT = 500/);
  assert.match(detailSource, /interactive cap \{RUN_EVENT_SCAN_LIMIT\}/);
});
