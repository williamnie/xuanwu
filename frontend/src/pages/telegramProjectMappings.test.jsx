import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TelegramProjectMappingsView } from './TelegramProjectMappings.jsx';
import { parseTelegramProjectMappings, serializeTelegramProjectMappings } from './telegramProjectMappings.js';

test('Telegram mapping edits keep the existing chat/user string payload and large source IDs', () => {
  const value = 'chat:-100123456789012345=project-one,user:987654321098765432=project-two';
  const rows = parseTelegramProjectMappings(value);
  assert.equal(serializeTelegramProjectMappings(rows), value);
  rows[1].projectId = 'another-project';
  assert.equal(serializeTelegramProjectMappings(rows), 'chat:-100123456789012345=project-one,user:987654321098765432=another-project');
  assert.deepEqual(parseTelegramProjectMappings(''), []);
  assert.equal(serializeTelegramProjectMappings([]), '');
  assert.deepEqual(parseTelegramProjectMappings(' chat:-123=one\nuser:456=two '), [{ source: 'chat:-123', projectId: 'one' }, { source: 'user:456', projectId: 'two' }]);
  const panel = readFileSync(new URL('./TelegramSettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /project_mappings: data\?\.project_mappings \|\| ''/);
  assert.match(panel, /updateTelegramSettings\(state\.form\)/);
  assert.doesNotMatch(panel, /textarea[^>]*project_mappings/);
});

test('Telegram project choices come from selectProjects and retain unavailable current values', () => {
  const source = readFileSync(new URL('./TelegramProjectMappings.jsx', import.meta.url), 'utf8');
  assert.match(source, /useDataStore\(selectProjects\)/);
  const html = renderToStaticMarkup(<TelegramProjectMappingsView projects={[{ id: 'one', name: 'Project One' }]} value="chat:-123=missing,user:456=one" onChange={() => {}} />);
  assert.match(html, /<select/);
  assert.match(html, /value="one"[^>]*>Project One/);
  assert.match(html, /value="missing" selected="">missing · 当前值/);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(renderToStaticMarkup(<TelegramProjectMappingsView projects={[]} value="user:456=one" onChange={() => {}} />), /value="one" selected="">one · 当前值/);
});
