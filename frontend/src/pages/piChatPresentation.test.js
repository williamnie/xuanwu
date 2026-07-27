import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayPiConversationTitle,
  piChatStatusSummary,
  piChatWorkLinks,
} from './piChatPresentation.js';
import { translate } from '../i18n/translations.js';

test('Chat placeholder titles use the user-facing label without changing persisted conversation values', () => {
  assert.equal(displayPiConversationTitle({ title: 'New conversation' }), 'New chat');
  assert.equal(displayPiConversationTitle({ title: 'Runner' }), 'New chat');
  assert.equal(displayPiConversationTitle({ title: 'Feishu · oc_0013125cb6000e045fd9c7796e2367d6' }), 'Feishu chat');
  assert.equal(displayPiConversationTitle({ title: '598f6f2a-12ab-4f66-8f3c-a1c4ad4d519b' }), 'Chat');
  assert.equal(displayPiConversationTitle({ title: '修复上传失败' }), '修复上传失败');
});

test('Chat status summary favors user progress over runtime details', () => {
  assert.deepEqual(piChatStatusSummary({ sending: true }), {
    detail: 'Xuanwu 正在更新此 Chat',
    label: '处理中',
    tone: 'running',
  });
  assert.deepEqual(piChatStatusSummary({
    conversation: { status: 'active' },
    transcript: [{ role: 'user' }, { role: 'assistant' }],
  }), {
    detail: '2 条消息',
    label: '已更新',
    tone: 'ready',
  });
  assert.equal(piChatStatusSummary({ error: 'provider raw failure' }).label, '需要重试');
  assert.equal(piChatStatusSummary({
    conversation: { status: 'active' },
    transcript: [{ role: 'error' }],
  }).label, '上次未完成');
});

test('Chat presentation follows the selected language without rewriting persisted content', () => {
  const t = (key, variables) => translate('en-US', key, variables);
  assert.equal(displayPiConversationTitle({ title: 'New conversation' }, t), 'New chat');
  assert.deepEqual(piChatStatusSummary({ sending: true, t }), {
    detail: 'Xuanwu is updating this chat',
    label: 'Working',
    tone: 'running',
  });
});

test('Chat builds canonical Work links from existing transcript text and metadata', () => {
  assert.deepEqual(piChatWorkLinks([
    { text: '已创建 issue #699，并关联 xw:work:issues:700。' },
    { meta: { issue_ids: [701, 699], work_id: 'xw:work:external:delivery-9' }, text: 'Work 702 is next' },
  ]), [
    { id: 'xw:work:issues:700', label: 'Work #700' },
    { id: 'xw:work:issues:699', label: 'Work #699' },
    { id: 'xw:work:external:delivery-9', label: 'Work delivery-9' },
    { id: 'xw:work:issues:701', label: 'Work #701' },
    { id: 'xw:work:issues:702', label: 'Work #702' },
  ]);
});
