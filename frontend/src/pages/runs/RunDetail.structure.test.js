import { readSessionPageSource } from '../sessions/sessionTestSources.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detailSource = ['RunDetail.jsx', 'RunSummary.jsx', 'RunEventPanels.jsx', 'RunDetailPrimitives.jsx', 'useRunEvents.js', 'runDetailFormat.js'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const apiSource = readFileSync(new URL('../../api/runs.js', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./runDetailModel.js', import.meta.url), 'utf8');

const runsPageSource = readFileSync(new URL('../Runs.jsx', import.meta.url), 'utf8');
const sessionsSource = readSessionPageSource();
const chatSource = readFileSync(new URL('../sessions/SessionChatWorkspace.jsx', import.meta.url), 'utf8');
const infoSource = readFileSync(new URL('../sessions/SessionInfoPanel.jsx', import.meta.url), 'utf8');

test('Run Detail defaults to conversation and keeps diagnostics out of primary tabs', () => {
  for (const label of ['对话', '概览', '日志']) assert.ok(detailSource.includes(`label: '${label}'`));
  for (const label of ['Checks', 'Advanced']) assert.ok(!detailSource.includes(`label: '${label}'`));
  assert.match(detailSource, /aria-label="执行尝试"/);
  assert.match(detailSource, /attempts\.length > 1/);
  assert.match(detailSource, /useState\('provider'\)/);
  assert.match(detailSource, /<RunDetailContent key=\{run\.id\}/);
  assert.doesNotMatch(detailSource, /setActiveSection\('(?:summary|provider)'\)/);
  assert.doesNotMatch(detailSource, /Selected Attempt|Progress events|source events|Complete bounded projection/);
});

test('verification and developer events only mount inside opened disclosures', () => {
  assert.match(detailSource, /<RunDisclosure title="本次执行验证">\s*<EvidencePanel runId=\{run\.id\}/);
  assert.match(detailSource, /<RunDisclosure title="开发者信息">\s*<RunAdvanced/);
  assert.match(detailSource, /\{open \? children : null\}/);
  assert.match(detailSource, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(detailSource, /<RunAttention attempt=\{selectedAttempt\} run=\{run\} \/>/);
  assert.match(detailSource, /仅显示近期记录/);
  assert.doesNotMatch(detailSource, /normalized provider events|first_event_id.*last_event_id/);
});

test('only a manual attempt click pins selection; background updates keep following the latest', () => {
  assert.match(detailSource, /const \[pinnedAttemptId, setPinnedAttemptId\] = useState\(''\)/);
  assert.match(detailSource, /selectedRunAttempt\(run, pinnedAttemptId\)/);
  assert.match(detailSource, /onClick=\{\(\) => setPinnedAttemptId\(attempt.id\)\}/);
  assert.equal((detailSource.match(/setPinnedAttemptId\(/g) || []).length, 1);
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
  assert.match(chatSource, /编程工具 session 无法加载/);
  assert.match(chatSource, /role="alert"/);
  for (const field of ['provider_version', 'sdk_version', 'cli_version', 'protocol_version']) {
    assert.match(infoSource, new RegExp(field));
  }
  assert.match(infoSource, /session\?\.token_usage/);
  assert.doesNotMatch(chatSource, /message\.content|qodercli_version/);
  assert.doesNotMatch(infoSource, /qodercli_version|message\.content/);
});

test('logs, raw events, and transcript commentary use bounded Run APIs', () => {
  assert.match(apiSource, /request\(`\/api\/issues\/\$\{encodeURIComponent\(issueId\)\}\/events\?/);
  assert.match(apiSource, /\/api\/runs\/\$\{encodeURIComponent\(id\)\}\/transcript/);
  assert.match(detailSource, /getRunTranscript\(run\.id, \{ attemptId: attempt\?\.id \|\| '', limit: 200 \}\)/);
  assert.doesNotMatch(detailSource, /itemsView:\s*'full'/);
  assert.doesNotMatch(apiSource, /getRunApprovals|approval-requests/);
  assert.match(modelSource, /RUN_EVENT_PAGE_SIZE = 100/);
  assert.match(modelSource, /RUN_EVENT_SCAN_LIMIT = 500/);
  assert.match(detailSource, /scanned >= RUN_EVENT_SCAN_LIMIT/);
  assert.doesNotMatch(detailSource, /interactive cap|raw events scanned|bounded .*event pages/);
});
