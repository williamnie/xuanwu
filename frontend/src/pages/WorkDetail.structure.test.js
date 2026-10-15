import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detail = readFileSync(new URL('./WorkDetail.jsx', import.meta.url), 'utf8');
const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const model = readFileSync(new URL('./workDetailModel.js', import.meta.url), 'utf8');
const runList = readFileSync(new URL('./work/WorkRunList.jsx', import.meta.url), 'utf8');
const runsPage = readFileSync(new URL('./Runs.jsx', import.meta.url), 'utf8');
const reviewCard = readFileSync(new URL('./work/HumanReview.jsx', import.meta.url), 'utf8');
const reviewHook = readFileSync(new URL('./work/useHumanReview.jsx', import.meta.url), 'utf8');

test('Work Detail keeps Now above the tabs and puts result, description, runs and activity into tabs', () => {
  assert.match(detail, /t\('work\.sectionNow'\)/);
  assert.match(detail, /WORK_DETAIL_TABS\.map\(tab =>/);
  assert.match(detail, /role="tablist"/);
  assert.match(detail, /defaultWorkDetailTab\(workStatus, \{ selectedHandoffId, selectedRunId \}\)/);
  const nowIndex = detail.indexOf("t('work.sectionNow')");
  const tabsIndex = detail.indexOf('role="tablist"');
  assert.ok(nowIndex > 0 && nowIndex < tabsIndex);
  assert.ok(detail.indexOf('<HumanReviewCard') < tabsIndex, 'pending review must stay outside the tabs');
  assert.doesNotMatch(detail, /work-detail-view-tabs|activeView/);
  assert.match(detail, /workApi\.getWork\(workId\)/);
  assert.match(detail, /workApi\.getWorkTimeline/);
  assert.match(detail, /evidenceApi\.listEvidence/);
  assert.match(detail, /handoffsApi\.getHandoffs/);
  assert.match(detail, /<WorkDeliveryView/);
  assert.match(detail, /<WorkRunList/);
  assert.match(detail, /selectedRunId=\{selectedRunId\}/);
  assert.doesNotMatch(detail, /navigateTo\('handoffs'/);
  assert.match(detail, /activeTab === 'activity' && !activityLoaded/);
  assert.doesNotMatch(detail, /getWorkRelations|readiness|relationship|guardianAlerts|compatibility/);
  assert.doesNotMatch(detail, /<EvidencePanel/);
});

test('Task process lists runs and opens each one on the Runs page instead of embedding it', () => {
  assert.match(runList, /runsApi\.getRuns\(\{ page: 1, pageSize: RUN_PAGE_SIZE, workId \}\)/);
  assert.match(runList, /navigateTo\?\.\('runs', null, run\.id\)/);
  assert.match(runList, /RUN_REFRESH_EVENT_TYPES\.has/);
  assert.doesNotMatch(runList, /<RunContextBar|<RunDetail|runsApi\.getRun\(/);
  assert.doesNotMatch(detail, /<RunContextBar|<RunDetail/);
  assert.doesNotMatch(runsPage, /navigateTo\('tasks', run\.work_id/);
});

test('Task page lists and boards tasks and opens canonical Work Detail', () => {
  assert.match(board, /onViewChange/);
  assert.match(board, /WORK_BOARD_STATUSES\.map\(status =>/);
  assert.match(board, /navigateTo\('tasks', work\.id\)/);
  assert.doesNotMatch(board, /navigateTo\('issues', issueId\)/);
  assert.match(board, /work-card-identity/);
  assert.match(board, /`Issue #\$\{issueId\}`/);
  assert.doesNotMatch(board, /Issue #\$\{issueId\} authority/);
  assert.match(board, /<WorkDetail/);
  assert.match(board, /selectedHandoffId=\{selectedHandoffId\}/);
  assert.match(board, /selectedRunId=\{selectedRunId\}/);
  assert.doesNotMatch(board, /relations=|work-relation-row|indexRelationsByWork/);
});

test('Work Detail mutations use audited Work controls and the explicit human-review response', () => {
  assert.match(detail, /workApi\.controlWork\(work\.id, action, buildWorkActionPayload\(work, action\)\)/);
  assert.match(reviewHook, /workApi\.answerWorkHumanReview\(work\.id/);
  assert.match(detail, /useHumanReview\(/);
  assert.match(model, /expected_revision/);
  assert.doesNotMatch(detail, /window\.(alert|confirm)/);
});

test('Work Detail only exposes review for an explicit request and closes request-changes through the same Session', () => {
  assert.match(model, /decision\?\.owner === 'human'/);
  assert.match(detail, /<HumanReviewCard/);
  assert.match(reviewCard, /workHumanReviewActions\(request\.kind\)/);
  assert.match(detail, /decision\?\.phase === 'pi_deciding'/);
  assert.match(detail, /decision\?\.phase === 'pi_waiting'/);
  assert.match(detail, /decision\?\.phase === 'pi_error'/);
  assert.match(detail, /decision\?\.activity\?\.error/);
  assert.match(reviewCard, /submitChangesAndContinue/);
  assert.match(reviewCard, /reviewRevisionFlow/);
  assert.match(reviewHook, /review_request_id: request\?\.id/);
  assert.match(reviewHook, /review_revision: request\?\.revision/);
  assert.match(reviewHook, /request=\{pending\.request\}/);
  assert.match(reviewHook, /reviewError\.status === 409/);
  assert.match(detail, /<WorkFeedback feedback=\{detail\?\.feedback\}/);
});
