import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detailSource = readFileSync(new URL('./RunDetail.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../api/runs.js', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./runDetailModel.js', import.meta.url), 'utf8');

const runsPageSource = readFileSync(new URL('../Runs.jsx', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../sessions/SessionChatWorkspace.jsx', import.meta.url), 'utf8');
const infoSource = readFileSync(new URL('../sessions/SessionInfoPanel.jsx', import.meta.url), 'utf8');

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
  assert.match(detailSource, /useState\('summary'\)/);
  assert.match(detailSource, /setActiveSection\('summary'\)/);
});

test('provider observation is an embedded primary tab without duplicate Evidence', () => {
  assert.match(detailSource, /<Sessions/);
  assert.match(detailSource, /ProviderSessionDrillDown/);
  assert.match(detailSource, /showEvidence=\{false\}/);
  assert.doesNotMatch(detailSource, /useRunApprovals/);
  assert.doesNotMatch(detailSource, /interruptSession\(/);
  assert.doesNotMatch(detailSource, /sendSessionMessage\(/);
  assert.doesNotMatch(runsPageSource, /> Provider session/);
  assert.match(apiSource, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/turns/);
  assert.match(apiSource, /items_view: itemsView/);
});

test('embedded provider transcript exposes read failures and provider-neutral version/usage extensions', () => {
  assert.match(sessionsSource, /setDetailError\(message\)/);
  assert.match(chatSource, /Provider session 无法加载/);
  assert.match(chatSource, /role="alert"/);
  for (const field of ['provider_version', 'sdk_version', 'cli_version', 'protocol_version']) {
    assert.match(infoSource, new RegExp(field));
  }
  assert.match(infoSource, /session\?\.token_usage/);
  assert.doesNotMatch(chatSource, /message\.content|qodercli_version/);
  assert.doesNotMatch(infoSource, /qodercli_version|message\.content/);
});

test('logs and raw events reuse bounded existing APIs instead of expanding the Run contract', () => {
  assert.match(apiSource, /request\(`\/api\/issues\/\$\{encodeURIComponent\(issueId\)\}\/events\?/);
  assert.doesNotMatch(apiSource, /getRunApprovals|approval-requests/);
  assert.match(modelSource, /RUN_EVENT_PAGE_SIZE = 100/);
  assert.match(modelSource, /RUN_EVENT_SCAN_LIMIT = 500/);
  assert.match(detailSource, /interactive cap \{RUN_EVENT_SCAN_LIMIT\}/);
});
