import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeOperationalSnapshot, mergeRefreshedLanePages, normalizeBoardSnapshot } from './workKanbanModel.js';

test('轮询保留已加载历史任务，同时以新快照替换活动任务', () => {
  const history = { id: 'done', status: 'done' };
  const current = [{ id: 'old', status: 'todo' }, history, { id: 'moved', status: 'done' }];
  const refreshed = [{ id: 'new', status: 'todo' }, { id: 'moved', status: 'in_progress' }];
  assert.deepEqual(mergeOperationalSnapshot(current, refreshed), [...refreshed, history]);
});

test('刷新不会丢失已翻页的页码或重置已加载历史列', () => {
  const history = { page: 3, loadState: 'loaded', nextCursor: 'history-cursor' };
  const result = mergeRefreshedLanePages(
    { todo: { page: 4 }, done: history },
    { todo: { page: 1, nextCursor: 'fresh-cursor' }, done: { page: 0, loadState: 'not_loaded' } },
  );
  assert.deepEqual(result.todo, { page: 4, nextCursor: 'fresh-cursor' });
  assert.equal(result.done, history);
});

test('来源筛选不能使用全局历史计数，重复任务仍只保留一次', () => {
  const work = { id: 'same', status: 'todo' };
  const response = { page_size: 20, lanes: { todo: { items: [work, work], total: 1, has_more: true, next_cursor: 'next' } } };
  const summary = { counts: { done: 99 } };
  const all = normalizeBoardSnapshot(response, summary);
  const filtered = normalizeBoardSnapshot(response, summary, true);
  assert.equal(all.lanePages.done.total, 99);
  assert.equal(filtered.lanePages.done.total, undefined);
  assert.equal(filtered.lanePages.done.loadState, 'not_loaded');
  assert.equal(filtered.lanePages.todo.nextCursor, 'next');
  assert.equal(filtered.lanePages.todo.hasMore, true);
  assert.deepEqual(filtered.items, [work]);
});
