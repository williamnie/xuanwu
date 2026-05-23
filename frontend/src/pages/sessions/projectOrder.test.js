import assert from 'node:assert/strict';
import test from 'node:test';
import { moveProjectId, orderedProjectsAfterMove } from './projectOrder.js';

test('moves project id before drop target without mutating input', () => {
  const ids = ['a', 'b', 'c'];
  const next = moveProjectId(ids, 'c', 'a');
  assert.deepEqual(next, ['c', 'a', 'b']);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('keeps project order when source or target is invalid', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(moveProjectId(ids, 'a', 'a'), ids);
  assert.equal(moveProjectId(ids, 'missing', 'a'), ids);
  assert.equal(moveProjectId(ids, 'a', 'missing'), ids);
});

test('returns projects in moved order', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const next = orderedProjectsAfterMove(projects, 'a', 'c');
  assert.deepEqual(next.map((project) => project.id), ['b', 'c', 'a']);
});
