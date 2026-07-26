import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/projects.js', import.meta.url), 'utf8');

test('Projects exposes one PI takeover binding instead of auto-run policy switches', () => {
  assert.match(pageSource, /PI 自动接管/);
  assert.match(pageSource, /bindProjectToPi/);
  assert.match(pageSource, /unbindProjectFromPi/);
  assert.doesNotMatch(pageSource, /formAutoRun|handleToggleAutoRun/);
  assert.doesNotMatch(pageSource, /auto_manage|auto_triage|auto_enqueue|default_mode|supervisor_mode/);
});

test('projects API binds and unbinds the project through pi-settings', () => {
  assert.match(apiSource, /bindProjectToPi:[\s\S]*\/pi-settings[\s\S]*method: 'PATCH'/);
  assert.match(apiSource, /unbindProjectFromPi:[\s\S]*\/pi-settings[\s\S]*method: 'DELETE'/);
});
