import { readStylesheet } from '../../test-support/readStylesheet.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import IntegrationConnectionList from './IntegrationConnectionList.jsx';
import { connectionHealth, integrationChannelFromHash, loadConnectionStatus, receiverState } from './integrationConnections.js';
import { I18nContext } from '../i18n/context.js';
import { configureGuide } from './settingsProductModels.js';

const read = path => (path.endsWith('.css') ? readStylesheet : readFileSync)(new URL(path, import.meta.url), 'utf8');
const diagnostics = [{ id: 'feishu', health: { state: 'healthy' } }, { id: 'telegram', health: { state: 'failed' } }];
const registry = [{ id: 'feishu', receiver: { state: 'reconnecting' } }, { id: 'telegram', receiver: { state: 'polling' } }];
const render = (channels = registry, connectors = diagnostics, language = 'zh-CN') => renderToStaticMarkup(
  <I18nContext.Provider value={{ language }}><IntegrationConnectionList channels={channels} connectors={connectors} onConfigure={() => {}} /></I18nContext.Provider>,
);

test('connection rows retain registry-backed receiver states separately from diagnostic health', () => {
  const html = render();
  assert.equal((html.match(/接收器运行/g) || []).length, 2);
  for (const text of ['GitHub', '飞书', 'Telegram', 'healthy', 'failed', 'reconnecting', 'polling']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html.split('</li>')[0], /接收器运行/);
  assert.match(read('./integrationConnections.js'), /api\.getImChannels\(\)/);
  assert.match(read('../api/connectors.js'), /\/api\/integrations\/im\/channels/);
  for (const state of ['connected', 'reconnecting', 'failed', 'disabled', 'starting', 'polling', 'stopped']) {
    for (const id of ['feishu', 'telegram']) assert.equal(receiverState([{ id, receiver: { state } }], id), state);
  }
});

test('missing receiver and failed registry use neutral unknown without hiding health', async () => {
  let connectors; let channels;
  await loadConnectionStatus({ getPiConnectors: async () => ({ connectors: diagnostics }), getImChannels: async () => { throw new Error('offline'); } }, data => { connectors = data; }, data => { channels = data; });
  assert.deepEqual(connectors, diagnostics);
  assert.deepEqual(channels, []);
  const html = render(channels, connectors);
  assert.match(html, /healthy/);
  assert.match(html, /failed/);
  assert.match(html, /class="is-unknown">未知/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(receiverState([{ id: 'feishu' }], 'feishu'), 'unknown');
  assert.equal(receiverState([{ id: 'telegram', receiver: {} }], 'telegram'), 'unknown');
  assert.match(render([{ id: 'feishu' }, registry[1]]), /polling/);
  assert.match(render([], [], 'en-US'), /Unknown/);
});

test('diagnostic failures and slow registry requests do not block independent statuses', async () => {
  let connectors; let channels; let resolveRegistry;
  const pending = loadConnectionStatus({ getPiConnectors: async () => ({ connectors: diagnostics }), getImChannels: () => new Promise(resolve => { resolveRegistry = resolve; }) }, data => { connectors = data; }, data => { channels = data; });
  await Promise.resolve();
  assert.deepEqual(connectors, diagnostics);
  assert.equal(channels, undefined);
  resolveRegistry(registry);
  await pending;
  await loadConnectionStatus({ getPiConnectors: async () => { throw new Error('offline'); }, getImChannels: async () => registry }, data => { connectors = data; }, data => { channels = data; });
  assert.deepEqual(connectors, []);
  assert.match(render(channels, connectors), /polling/);
  assert.equal(connectionHealth([], 'github-events'), 'unknown');
  assert.equal(connectionHealth([{ id: 'github-events', status: 'configured', health: { state: 'failed' } }], 'github-events'), 'failed');
  await loadConnectionStatus({ getPiConnectors: async () => null, getImChannels: async () => ({}) }, data => { connectors = data; }, data => { channels = data; });
  assert.deepEqual([connectors, channels], [[], []]);
});

test('legacy integrations and notifications channel links select exactly the requested drawer', () => {
  for (const section of ['integrations', 'notifications']) {
    for (const channel of ['github', 'feishu', 'telegram']) assert.equal(integrationChannelFromHash(`#/settings?section=${section}&channel=${channel}`), channel);
  }
  for (const hash of ['#/settings?section=integrations', '#/settings?section=integrations&channel=health', '#/settings?section=diagnostics&channel=feishu', '#/work?channel=github']) assert.equal(integrationChannelFromHash(hash), '');
  const sections = read('./AssistantSettingsSections.jsx');
  assert.match(sections, /addEventListener\('hashchange', syncChannel\)/);
  assert.match(sections, /addEventListener\('popstate', syncChannel\)/);
  assert.match(sections, /params\.delete\('channel'\)/);
});

test('registry fields remain covered by connection rows and full diagnostics before retiring the panel', () => {
  const panel = read('./ConnectorDiagnosticsPanel.jsx');
  assert.match(panel, /connector\.label \|\| connector\.id/);
  assert.match(panel, /health\.state/);
  assert.match(panel, /connector\.permissions \|\| \[\]/);
  assert.match(panel, /item\.capability_id/);
  for (const channel of ['feishu', 'telegram']) {
    assert.ok(panel.includes(`#/settings?section=integrations&channel=${channel}`));
    assert.match(configureGuide({ id: channel }).body, /设置抽屉/);
    assert.match(configureGuide({ id: channel }, 'en-US').body, /settings drawer/);
  }
  for (const suffix of ['jsx', 'css']) assert.equal(existsSync(new URL(`./ImChannelRegistryPanel.${suffix}`, import.meta.url)), false);
});

test('drawers reuse ModalOverlay, preserve hidden children, trap focus and fill narrow viewports', () => {
  const drawer = read('./IntegrationSettingsDrawer.jsx');
  const css = read('./Settings.css');
  assert.match(drawer, /<ModalOverlay/);
  assert.match(drawer, /role="dialog" aria-modal="true"/);
  assert.match(drawer, /event\.key === 'Escape'/);
  assert.match(drawer, /event\.key !== 'Tab'/);
  assert.match(drawer, /previousFocus\.focus\(\)/);
  assert.match(drawer, /bodyRef\.current\.scrollTop = 0/);
  assert.match(css, /\.settings-connection-overlay\.is-closed \{ display: none; \}/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /background: var\(--surface-overlay\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.modal-content\.settings-connection-drawer \{ width: 100%; border: 0; \}/);
});
