import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFeishuSource, feishuSourceIncluded } from './feishuSourceModel.js';

test('Feishu selection appends both allowlists without replacing prior IDs or changing other settings', () => {
  const form = { allowed_chat_ids: 'oc_old; oc_old, oc_keep', allowed_user_ids: 'ou_old', default_chat_id: 'oc_default', default_user_id: 'ou_default', project_mappings: 'chat:oc_old=demo', app_id: 'cli_saved', app_secret: '' };
  const original = { ...form };
  const source = { chat_id: 'oc_new', user_id: 'ou_new' };
  const selected = appendFeishuSource(form, source);
  assert.deepEqual(selected, { ...form, allowed_chat_ids: 'oc_old, oc_keep, oc_new', allowed_user_ids: 'ou_old, ou_new' });
  assert.deepEqual(form, original);
  assert.equal(feishuSourceIncluded(form, source), false);
  assert.equal(feishuSourceIncluded(selected, source), true);
  assert.deepEqual(appendFeishuSource(selected, source), selected);
  assert.deepEqual(appendFeishuSource(selected, { chat_id: 'oc_new', user_id: 'ou_second' }), { ...selected, allowed_user_ids: 'ou_old, ou_new, ou_second' });
});
