import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('./ProjectSettingsEditor.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/projects.js', import.meta.url), 'utf8');

test('Projects treats PI takeover as the default project contract without an opt-out', () => {
  assert.match(editorSource, /projectsApi\.createProject\(\{ id: projectIdFromPath\(ui\.formCwd\), \.\.\.payload \}\)/);
  assert.match(editorSource, /创建并接管/);
  assert.doesNotMatch(pageSource, /ProjectMetaRow|PI 无人值守接管/);
  assert.doesNotMatch(pageSource, /formPiManaged|handleTogglePiManaged|isTakeoverEnabled/);
  assert.doesNotMatch(pageSource, /bindProjectToPi|unbindProjectFromPi/);
  assert.doesNotMatch(pageSource, /暂停监听|开启监听/);
  assert.doesNotMatch(pageSource, /handleStartLoop|handleStopLoop/);
  assert.doesNotMatch(pageSource, /formAutoRun|handleToggleAutoRun/);
  assert.doesNotMatch(pageSource, /auto_manage|auto_triage|auto_enqueue|default_mode|supervisor_mode/);
});

test('Projects client does not expose takeover or loop toggles', () => {
  assert.doesNotMatch(apiSource, /bindProjectToPi|unbindProjectFromPi/);
  assert.doesNotMatch(apiSource, /startProjectLoop|stopProjectLoop/);
});
