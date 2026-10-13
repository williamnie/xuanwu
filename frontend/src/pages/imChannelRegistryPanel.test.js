import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('./ImChannelRegistryPanel.jsx', import.meta.url), 'utf8');
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');

test('Web settings omit internal IM registry while preserving its API', () => {
  assert.doesNotMatch(sections, /ImChannelRegistryPanel/);
  assert.match(panel, /connectorsApi\.getImChannels/);
  assert.match(api, /\/api\/integrations\/im\/channels/);
});
