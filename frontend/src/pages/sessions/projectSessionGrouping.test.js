import assert from 'node:assert/strict';
import test from 'node:test';
import { projectForSession } from './projectSessionGrouping.js';

test('session project_id wins when an indexed provider session has no cwd', () => {
  const project = { id: 'xuanwu', cwd: '/tmp/xuanwu' };
  const projectsById = new Map([[project.id, project]]);
  const projectsByCwd = new Map([[project.cwd, project]]);

  assert.equal(projectForSession({ project_id: 'xuanwu', cwd: '' }, projectsById, projectsByCwd), project);
  assert.equal(projectForSession({ project_id: '', cwd: '/tmp/xuanwu' }, projectsById, projectsByCwd), project);
});
