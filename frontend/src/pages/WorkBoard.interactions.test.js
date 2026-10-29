import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const board = readFileSync(new URL('./WorkBoard.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./WorkBoard.css', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('../components/GlobalAskComposer.css', import.meta.url), 'utf8');
const editorDialog = readFileSync(new URL('./work/WorkEditorDialog.jsx', import.meta.url), 'utf8');
const actions = readFileSync(new URL('./work/workActions.js', import.meta.url), 'utf8');

test('new Work goal uses the image-capable prompt composer', () => {
  assert.match(editorDialog, /<PromptEditor[\s\S]*onChange=\{value => setField\('goal', value\)\}[\s\S]*variant="composer"/);
  assert.doesNotMatch(editorDialog, /<textarea[\s\S]*work-goal-input/);
  assert.match(css, /\.work-dialog-field \.prompt-editor-shell\.composer/);
});

test('new task keeps the title optional and calls the executor choice a preset', () => {
  assert.match(editorDialog, /<span>\{t\('editor\.title'\)\} <small>（可选）<\/small><\/span>/);
  assert.doesNotMatch(editorDialog, /onChange=\{event => onChange\(event\.target\.value\)\} required/);
  assert.match(editorDialog, /<span>\{t\('work\.profile\.preset'\)\}<\/span>/);
  assert.match(editorDialog, /setField\('status', event\.target\.checked \? 'todo' : 'triage'\)/);
  assert.doesNotMatch(editorDialog, /Effective:|Work 显式/);
  assert.match(editorDialog, /<AgentProfileSelectOptions/);
  assert.match(editorDialog, /workCatalogSelection\(catalogState, catalogKey, draft\.agent_profile_id, selectedProject,\s*editing \? work\?\.agent_profile_id \|\| '' : null\)/);
  assert.match(editorDialog, /open=\{!selectedCodeAgentAvailable \|\| Boolean\(nodeId\) \|\| undefined\}/);
  assert.match(editorDialog, /if \(!selectedCodeAgentAvailable\)/);
});

test('Work Board cards restore drag and drop through guarded Issue actions', () => {
  assert.match(board, /draggable=\{!moving\}/);
  assert.match(board, /onDrop=\{event => onDrop\(event, status\)\}/);
  assert.match(board, /workDropOperation\(work\.status, targetStatus\)/);
  assert.match(board, /executeWorkMove\(work, targetStatus\)/);
  assert.match(actions, /workDropOperation\(work\.status, targetStatus\)/);
  assert.match(actions, /operation === 'enqueue'[\s\S]*workApi\.enqueueIssue\(issueId\)/);
  assert.match(actions, /operation === 'retry'[\s\S]*workApi\.retryIssue\(issueId\)/);
  assert.match(actions, /operation === 'cancel'[\s\S]*workApi\.cancelIssue\(issueId\)/);
  assert.match(actions, /workApi\.updateIssue\(issueId, \{ status: targetStatus \}\)/);
  assert.match(board, /t\('board\.dropBlocked'\)/);
});

test('Work Board keeps the viewport fixed and scrolls each lane independently', () => {
  assert.match(css, /\.work-board-page\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.work-board-scroll\s*\{[\s\S]*flex:\s*1;[\s\S]*overflow-y:\s*hidden;/);
  assert.match(css, /\.work-column\s*\{[\s\S]*display:\s*flex;[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0;/);
  assert.match(css, /\.work-column-stack\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/);
});

test('Work Board opens from one grouped snapshot and loads only the scrolled lane', () => {
  assert.match(board, /workApi\.getWorkBoard\(\{\s*statuses: OPERATIONAL_STATUSES,[\s\S]*?\}, \{ signal: controller\.signal \}\)/);
  assert.match(board, /statuses: \[status\]/);
  assert.match(board, /cursor: lane\.nextCursor/);
  assert.match(board, /page: lane\.nextCursor \? 1 : lane\.page \+ 1/);
  assert.match(board, /onScroll=\{event => onReachEnd\(event, status\)\}/);
  assert.match(board, /laneScrollArmed/);
  assert.match(board, /t\('board\.loadMoreStatus', \{ status: t\(`status\.\$\{status\}`\) \}\)/);
  assert.doesNotMatch(board, /getAllWorks|getAllWorkRelations/);
  assert.match(board, /HISTORY_STATUSES\.includes\(status\)/);
  assert.match(board, /normalizeLanePage\([^\n]+, response\?\.page_size \|\| 20, 'not_loaded'\)/);
  assert.match(board, /IntersectionObserver/);
  assert.match(board, /loadState === 'not_loaded'[\s\S]*滚动到此列后加载历史任务/);
  assert.match(board, /loadState === 'error'[\s\S]*历史任务加载失败，重试/);
});

test('Work Board silently refreshes every five seconds without overlapping requests', () => {
  assert.match(board, /WORK_REFRESH_INTERVAL_MS\s*=\s*5_000/);
  assert.match(board, /if \(boardRequest\.current\)[\s\S]*await boardRequest\.current\.catch/);
  assert.match(board, /await loadBoard\(\{ silent: true \}\)/);
  assert.match(board, /setWorks\(current => mergeOperationalSnapshot\(current, snapshot\.items\)\)/);
  assert.match(board, /HISTORY_STATUSES\.includes\(work\.status\)/);
  assert.match(board, /setLanePages\(current => mergeRefreshedLanePages\(current, snapshot\.lanePages\)\)/);
  assert.match(board, /window\.clearTimeout\(timer\)/);
  assert.match(board, /BOARD_RECONCILE_EVENT_TYPES/);
  assert.match(board, /window\.setTimeout\([\s\S]*loadBoard\(\{ silent: true \}\)[\s\S]*500/);
});

test('Work Board avoids learned intrinsic card heights that move the lane scrollbar', () => {
  assert.match(css, /\.work-card\s*\{[\s\S]*contain:\s*layout paint style;/);
  assert.doesNotMatch(css, /content-visibility|contain-intrinsic-size/);
  assert.match(css, /\.work-column-stack\s*\{[\s\S]*scrollbar-gutter:\s*stable;/);
});

test('Task page keeps search in the header, defaults to the list and keeps the board one click away', () => {
  assert.doesNotMatch(board, /work-ledger-stats|CompatibilityNotice/);
  assert.match(board, /className="work-header-search"/);
  assert.match(board, /aria-label=\{t\('board\.search'\)\}/);
  assert.match(board, /localStorage\.getItem\(TASK_VIEW_STORAGE_KEY\) === 'board' \? 'board' : 'list'/);
  assert.match(board, /view === 'list' \? \([\s\S]*<TaskList[\s\S]*<WorkKanban/);
  assert.match(board, /<TaskSubviewTabs active="tasks"/);
  assert.doesNotMatch(board, /board\.count|board\.filteredCount/);
  assert.doesNotMatch(composerCss, /\.main-content\.has-global-ask-composer\s*\{/);
});


test('task project selection uses the URL-owned filter for both views and existing list requests', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const list = readFileSync(new URL('./work/TaskList.jsx', import.meta.url), 'utf8');
  assert.match(app, /<WorkBoard\s+filterProject=\{filterProject\}\s+onProjectChange=\{setFilterProject\}/);
  assert.match(board, /filterProject: projectId = ''/);
  assert.doesNotMatch(board, /\[projectId, setProjectId\]/);
  assert.match(board, /<WorkBoardHeader[\s\S]*?onProjectChange=\{onProjectChange\}/);
  assert.match(board, /<TaskList[\s\S]*?projectId=\{projectId\}/);
  assert.match(board, /<WorkKanban[\s\S]*?projectId=\{projectId\}/);
  assert.match(list, /workApi\.getWorks\(\{\s*pageSize: PAGE_SIZE,\s*projectId,/);
});

test('task source resets list and board pagination, carries through history lanes, and avoids unfiltered counts', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const list = readFileSync(new URL('./work/TaskList.jsx', import.meta.url), 'utf8');
  assert.match(app, /draft\.taskSource = route\.taskSource/);
  assert.match(app, /onSourceChange=\{setTaskSource\}/);
  assert.match(board, /<select aria-label=\{t\('board\.source'\)\}[\s\S]*value=\{source\}/);
  assert.match(board, /<TaskList\s+key=\{`\$\{projectId\}:\$\{taskSource\}:\$\{scope\}:\$\{query\}`\}/);
  assert.match(board, /<WorkKanban\s+key=\{`\$\{projectId\}:\$\{taskSource\}:\$\{query\}`\}/);
  assert.equal((board.match(/source \? \{ source, projectId, query \} : \{\}/g) || []).length, 3);
  assert.equal((list.match(/projectId,\s*source,\s*query: query\.trim\(\)/g) || []).length, 2);
  assert.match(list, /source \? \(item\.id === scope \? total \?\? '' : ''\)/);
  assert.match(board, /if \(source\) return;/);
  assert.match(css, /\.work-header-source\s*\{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
  assert.match(css, /@media \(max-width: 760px\)\s*\{\s*\.work-header-search \{ flex-basis: 100%; \}/);
});
