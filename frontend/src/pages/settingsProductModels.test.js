import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNotificationPreferencePayload,
  configureGuide,
  connectorPermissionRows,
} from './settingsProductModels.js';

test('connection configure guides reuse declared secret refs and existing provider authority', () => {
  const github = configureGuide({ id: 'github-events', secret_refs: [{ ref: 'secret://integrations/github/token' }] });
  const tracker = configureGuide({ id: 'gitlab-issues', secret_refs: [{ ref: 'env://GITLAB_TOKEN' }] });
  const webhook = configureGuide({ id: 'webhook', secret_refs: [{ ref: 'env://XUANWU_WEBHOOK_SIGNING_SECRET' }] });

  assert.match(github.title, /Git provider/);
  assert.match(github.body, /不在 Settings 创建第二份 token/);
  assert.equal(github.refs, 'secret://integrations/github/token');
  assert.match(tracker.title, /Tracker provider/);
  assert.match(tracker.body, /Issue authority/);
  assert.match(webhook.title, /Webhook/);
});

test('permission rows are projected from connector API capabilities', () => {
  assert.deepEqual(connectorPermissionRows([{ id: 'feishu', label: 'Feishu IM', permissions: [
    { authorization: 'required', capability_id: 'message.reply', direction: 'outbound' },
  ] }]), [{
    authorization: 'required',
    capabilityID: 'message.reply',
    connectorID: 'feishu',
    connectorLabel: 'Feishu IM',
    direction: 'outbound',
  }]);
  assert.deepEqual(connectorPermissionRows(null), []);
});

test('notification settings write one global preference without replacing channel policy', () => {
  const digestPolicy = { channels: ['feishu'], daily_at: '09:00' };
  assert.deepEqual(buildNotificationPreferencePayload({ digestPolicy, mode: 'digest', notifyOn: ['needs_user'] }), {
    digest_policy: digestPolicy,
    mode: 'digest',
    notify_on: ['needs_user'],
    policy_kind: 'user_preference',
    scope: 'global',
    source_message_id: 'settings:notifications',
  });
});
