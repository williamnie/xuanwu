import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFeishuSource, feishuSourceChoices, feishuSourceIncluded, feishuUsersEmpty } from './feishuSourceModel.js';

const form = { allowed_chat_ids: 'oc_old; oc_old, oc_keep', allowed_user_ids: 'ou_old', default_chat_id: 'oc_default', default_user_id: 'ou_default', project_mappings: 'chat:oc_old=demo', app_id: 'cli_saved', app_secret: '' };
const source = { chat_id: 'oc_new', user_id: 'ou_new' };

test('Feishu direct selection appends both allowlists without replacing prior IDs or changing other settings', () => {
  const original = { ...form };
  const direct = { ...source, chat_type: 'direct' };
  assert.deepEqual(feishuSourceChoices(direct), ['direct']);
  const selected = appendFeishuSource(form, direct, 'direct');
  assert.deepEqual(selected, { ...form, allowed_chat_ids: 'oc_old, oc_keep, oc_new', allowed_user_ids: 'ou_old, ou_new' });
  assert.deepEqual(form, original);
  assert.equal(feishuSourceIncluded(form, direct, 'direct'), false);
  assert.equal(feishuSourceIncluded(selected, direct, 'direct'), true);
  assert.equal(feishuSourceIncluded({ ...selected, allowed_user_ids: '' }, direct, 'direct'), false);
  assert.equal(feishuSourceIncluded({ ...selected, allowed_chat_ids: '' }, direct, 'direct'), false);
  assert.deepEqual(appendFeishuSource(selected, direct, 'direct'), selected);
  assert.deepEqual(appendFeishuSource(selected, { ...direct, user_id: 'ou_second' }, 'direct'), { ...selected, allowed_user_ids: 'ou_old, ou_new, ou_second' });
});

for (const chat_type of ['group', 'unknown', undefined]) {
  test(`Feishu ${chat_type || 'missing type'} separates user and chat grants, with no default selection`, () => {
    const candidate = { ...source, chat_type };
    const original = { ...form };
    assert.deepEqual(feishuSourceChoices(candidate), ['user', 'chat']);
    assert.equal(feishuSourceIncluded(form, candidate, 'user'), false);
    assert.equal(feishuSourceIncluded(form, candidate, 'chat'), false);
    const userOnly = appendFeishuSource(form, candidate, 'user');
    assert.deepEqual(userOnly, { ...form, allowed_user_ids: 'ou_old, ou_new' });
    assert.equal(feishuSourceIncluded(userOnly, candidate, 'user'), true);
    assert.equal(feishuSourceIncluded(userOnly, candidate, 'chat'), false);
    assert.deepEqual(appendFeishuSource(userOnly, candidate, 'user'), userOnly);
    const chatOnly = appendFeishuSource(form, candidate, 'chat');
    assert.deepEqual(chatOnly, { ...form, allowed_chat_ids: 'oc_old, oc_keep, oc_new' });
    assert.equal(feishuSourceIncluded(chatOnly, candidate, 'user'), false);
    assert.equal(feishuSourceIncluded(chatOnly, candidate, 'chat'), true);
    assert.deepEqual(appendFeishuSource(chatOnly, candidate, 'chat'), chatOnly);
    for (const choice of [undefined, 'direct', 'invalid']) {
      assert.deepEqual(appendFeishuSource(form, candidate, choice), form);
      assert.equal(feishuSourceIncluded(form, candidate, choice), false);
    }
    assert.deepEqual(form, original);
  });
}

test('Feishu approval hint follows an empty or separator-only user allowlist, independently of chat grants', () => {
  for (const allowed_user_ids of ['', ' , ;  ', undefined]) {
    const empty = { ...form, allowed_user_ids };
    assert.equal(feishuUsersEmpty(empty), true);
    assert.equal(feishuUsersEmpty(appendFeishuSource(empty, { ...source, chat_type: 'group' }, 'chat')), true);
    assert.equal(feishuUsersEmpty(appendFeishuSource(empty, { ...source, chat_type: 'group' }, 'user')), false);
  }
  assert.equal(feishuUsersEmpty(form), false);
});
