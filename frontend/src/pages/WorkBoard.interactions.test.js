import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./WorkBoard.css', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('../components/GlobalAskComposer.css', import.meta.url), 'utf8');

test('Work Board cards restore drag and drop through guarded Issue actions', () => {
  assert.match(board, /draggable=\{!moving\}/);
  assert.match(board, /onDrop=\{event => onDrop\(event, status\)\}/);
  assert.match(board, /workDropOperation\(work\.status, targetStatus\)/);
  assert.match(board, /operation === 'enqueue'[\s\S]*workApi\.enqueueIssue\(issueId\)/);
  assert.match(board, /operation === 'retry'[\s\S]*workApi\.retryIssue\(issueId\)/);
  assert.match(board, /operation === 'cancel'[\s\S]*workApi\.cancelIssue\(issueId\)/);
  assert.match(board, /workApi\.updateIssue\(issueId, \{ status: targetStatus \}\)/);
  assert.match(board, /该状态由执行或验收流程推进，不能手动拖入/);
});

test('Work Board keeps the viewport fixed and scrolls each lane independently', () => {
  assert.match(css, /\.work-board-page\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.work-board-scroll\s*\{[\s\S]*flex:\s*1;[\s\S]*overflow-y:\s*hidden;/);
  assert.match(css, /\.work-column\s*\{[\s\S]*display:\s*flex;[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0;/);
  assert.match(css, /\.work-column-stack\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/);
});

test('Work Board opens from one grouped snapshot and loads only the scrolled lane', () => {
  assert.match(board, /workApi\.getWorkBoard\(\{\}, \{ signal: controller\.signal \}\)/);
  assert.match(board, /statuses: \[status\]/);
  assert.match(board, /page: lane\.page \+ 1/);
  assert.match(board, /onScroll=\{event => onReachEnd\(event, status\)\}/);
  assert.match(board, /laneScrollArmed/);
  assert.match(board, /继续加载 \$\{meta\.label\}/);
  assert.doesNotMatch(board, /getAllWorks|getAllWorkRelations/);
});

test('Work Board avoids learned intrinsic card heights that move the lane scrollbar', () => {
  assert.match(css, /\.work-card\s*\{[\s\S]*contain:\s*layout paint style;/);
  assert.doesNotMatch(css, /content-visibility|contain-intrinsic-size/);
  assert.match(css, /\.work-column-stack\s*\{[\s\S]*scrollbar-gutter:\s*stable;/);
});

test('Work Board keeps search in the header, exposes board only, and restores height when the global composer is collapsed', () => {
  assert.doesNotMatch(board, /work-ledger-stats|CompatibilityNotice/);
  assert.match(board, /className="work-header-search"/);
  assert.match(board, /aria-label="搜索 Work"/);
  assert.doesNotMatch(board, /WorkFilters|WorkList|onViewChange|work-filter-toggle/);
  assert.match(composerCss, /global-ask-composer-shell\.collapsed[\s\S]*padding-bottom:\s*88px;/);
});
