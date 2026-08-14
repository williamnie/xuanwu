import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./WorkBoard.css', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('../components/GlobalAskComposer.css', import.meta.url), 'utf8');
const editorDialog = readFileSync(new URL('./work/WorkEditorDialog.jsx', import.meta.url), 'utf8');

test('new Work goal uses the image-capable prompt composer', () => {
  assert.match(editorDialog, /<PromptEditor[\s\S]*onChange=\{value => setField\('goal', value\)\}[\s\S]*variant="composer"/);
  assert.doesNotMatch(editorDialog, /<textarea[\s\S]*work-goal-input/);
  assert.match(css, /\.work-dialog-field \.prompt-editor-shell\.composer/);
});

test('new Work makes the title optional and calls the executor choice Code Agent', () => {
  assert.match(editorDialog, /<span>\{t\('editor\.title'\)\} <small>（可选）<\/small><\/span>/);
  assert.doesNotMatch(editorDialog, /onChange=\{event => setField\('title', event\.target\.value\)\} required/);
  assert.match(editorDialog, /<span>Code Agent<\/span>/);
  assert.match(editorDialog, /<AgentProfileSelectOptions/);
  assert.match(editorDialog, /draft\.agent_profile_id === \(work\?\.agent_profile_id \|\| ''\)/);
});

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
  assert.match(board, /t\('board\.loadMoreStatus', \{ status: t\(`status\.\$\{status\}`\) \}\)/);
  assert.doesNotMatch(board, /getAllWorks|getAllWorkRelations/);
});

test('Work Board avoids learned intrinsic card heights that move the lane scrollbar', () => {
  assert.match(css, /\.work-card\s*\{[\s\S]*contain:\s*layout paint style;/);
  assert.doesNotMatch(css, /content-visibility|contain-intrinsic-size/);
  assert.match(css, /\.work-column-stack\s*\{[\s\S]*scrollbar-gutter:\s*stable;/);
});

test('Work Board keeps search in the header, exposes board only, and does not lose height to the global composer', () => {
  assert.doesNotMatch(board, /work-ledger-stats|CompatibilityNotice/);
  assert.match(board, /className="work-header-search"/);
  assert.match(board, /aria-label=\{t\('board\.search'\)\}/);
  assert.doesNotMatch(board, /WorkFilters|WorkList|onViewChange|work-filter-toggle/);
  assert.doesNotMatch(composerCss, /\.main-content\.has-global-ask-composer\s*\{/);
});
