import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateHubHost, nodeProviderSummary, nodeReadyProviders, nodeStartCommand, nodeStatus } from './remoteNodesModel.js';

test('private hub hosts cover LAN, Tailscale and local names', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.8', '100.101.102.103', 'box.local', 'hub.tail1234.ts.net', '[::1]', 'fd7a:115c:a1e0::1']) {
    assert.equal(isPrivateHubHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'xuanwu.example.com', '2001:db8::1']) {
    assert.equal(isPrivateHubHost(host), false, host);
  }
});

test('node status distinguishes offline, private and public connections', () => {
  assert.deepEqual(nodeStatus({ online: false }), { dot: 'idle', label: '离线', tone: 'muted' });
  assert.equal(nodeStatus({ online: true, private_network: true }).label, '在线');
  assert.equal(nodeStatus({ online: true, private_network: false }).tone, 'warning');
});

test('provider summary and ready providers come from the node handshake', () => {
  const node = {
    last_seen_at: '2026-10-27T00:00:00Z',
    info: { providers: [
      { capabilities: ['issue_execution'], id: 'codex', ready: true },
      { capabilities: ['issue_execution'], id: 'claude', ready: false },
    ] },
  };
  assert.equal(nodeProviderSummary(node), 'codex · claude（不可用）');
  assert.deepEqual(nodeReadyProviders(node), ['codex']);
  assert.equal(nodeProviderSummary({ info: { providers: [] } }), '尚未连接');
});

test('start command passes the token through the environment', () => {
  assert.equal(
    nodeStartCommand({ hubUrl: 'http://100.64.0.1:8787', token: 'xwn_abc' }),
    'XUANWU_NODE_TOKEN=xwn_abc xuanwu node --hub http://100.64.0.1:8787 --root <项目所在目录>',
  );
});
