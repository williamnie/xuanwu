import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  filterWorkBoardItems,
  indexRelationsByWork,
  issueIdFromWorkId,
  resolveWorkBoardPage,
  workBoardEnabled,
  workDeliveryStage,
  workNeedsAttention,
} from './workBoardModel.js';

const works = [
  work('xw:work:issues:11', 'triage', 'alpha', 'engineering_task'),
  work('xw:work:issues:12', 'done', 'beta', 'engineering_task'),
  work('xw:work:issues:13', 'in_progress', 'alpha', 'objective'),
];
const relations = indexRelationsByWork([
  { lifecycle: 'failed', work_id: works[2].id },
]);

test('feature flag falls back from Work to the legacy Issues route', () => {
  assert.equal(workBoardEnabled({}), true);
  assert.equal(workBoardEnabled({ VITE_WORK_BOARD_ENABLED: 'false' }), false);
  assert.equal(resolveWorkBoardPage('work', false), 'issues');
  assert.equal(resolveWorkBoardPage('issues', false), 'issues');
});

test('Issue-backed Work IDs produce stable Issues deep links', () => {
  assert.equal(issueIdFromWorkId('xw:work:issues:655'), 655);
  assert.equal(issueIdFromWorkId('xw:work:external:655'), null);
  assert.equal(issueIdFromWorkId('xw:work:issues:0'), null);
});

test('Attention and delivery projections stay deterministic', () => {
  assert.equal(workNeedsAttention(works[0]), true);
  assert.equal(workNeedsAttention(works[1]), false);
  assert.equal(workNeedsAttention(works[2], relations.get(works[2].id)), true);
  assert.equal(workDeliveryStage(works[1]), 'delivered');
  assert.equal(workDeliveryStage(works[2]), 'outstanding');
});

test('board filters combine type, status, project, Attention and delivery', () => {
  assert.deepEqual(
    filterWorkBoardItems(works, relations, { attention: 'required', delivery: 'outstanding', project: 'alpha', query: '', status: '', type: '' })
      .map(item => item.id),
    ['xw:work:issues:11', 'xw:work:issues:13'],
  );
  assert.deepEqual(
    filterWorkBoardItems(works, relations, { attention: '', delivery: 'delivered', project: '', query: 'issues:12', status: 'done', type: 'engineering_task' })
      .map(item => item.id),
    ['xw:work:issues:12'],
  );
});

test('Work and Issues remain separate, lazy App routes backed by the domain client', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../api/work.js', import.meta.url), 'utf8');

  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/WorkBoard'\)\)/);
  assert.match(app, /currentPage === 'work'/);
  assert.match(app, /resolveWorkBoardPage/);
  assert.match(sidebar, /aria-label="Work"/);
  assert.match(sidebar, /aria-label="Issues"/);
  assert.match(client, /request\('\/api\/works'/);
  assert.match(client, /request\(`\/api\/works\/\$\{encodeURIComponent\(id\)\}`/);
});

function work(id, status, projectId, type) {
  return {
    goal: `${id} goal`,
    id,
    owner: { kind: 'project', project_id: projectId },
    status,
    title: `${id} title`,
    type,
  };
}
