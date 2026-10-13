import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const panelExists = existsSync(new URL('./ImChannelRegistryPanel.jsx', import.meta.url));
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Web settings omit internal IM registry while preserving its API', () => {
  assert.doesNotMatch(sections, /ImChannelRegistryPanel/);
  assert.equal(panelExists, false);
  assert.match(api, /\/api\/integrations\/im\/channels/);
});
