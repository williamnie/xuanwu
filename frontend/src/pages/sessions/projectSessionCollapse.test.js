import assert from 'node:assert/strict';
import test from 'node:test';

import { isProjectSessionGroupCollapsed } from './projectSessionCollapse.js';

const emptyGroup = { id: 'empty', sessions: [] };
const activeGroup = { id: 'active', sessions: [{ id: 'session-1' }] };

test('empty project session groups default to collapsed', () => {
  assert.equal(isProjectSessionGroupCollapsed(emptyGroup), true);
});

test('projects with sessions keep the existing default expanded behavior', () => {
  assert.equal(isProjectSessionGroupCollapsed(activeGroup), false);
});

test('manual collapse state overrides empty project default', () => {
  assert.equal(isProjectSessionGroupCollapsed(emptyGroup, { empty: false }), false);
  assert.equal(isProjectSessionGroupCollapsed(activeGroup, { active: true }), true);
});

test('filter mode keeps empty state text reachable by disabling auto-collapse', () => {
  assert.equal(
    isProjectSessionGroupCollapsed(emptyGroup, {}, { autoCollapseEmptyProjects: false }),
    false,
  );
});
