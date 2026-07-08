import { message } from '../store/toastStore.js';

function cleanText(value) {
  return String(value || '').trim();
}

function debugLines(pairs) {
  return pairs
    .map(([label, value]) => [label, cleanText(value)])
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

export function formatPiConversationDebugInfo(conversation = {}) {
  return debugLines([
    ['type', 'pi_conversation'],
    ['conversation_id', conversation.id],
    ['pi_session_id', conversation.pi_session_id],
    ['title', conversation.title],
    ['status', conversation.status],
    ['project_id', conversation.project_id],
    ['pi_agent_id', conversation.pi_agent_id],
    ['created_at', conversation.created_at],
    ['updated_at', conversation.updated_at],
    ['api', conversation.id ? `/api/pi/conversations/${conversation.id}` : ''],
  ]);
}

export function formatPiMessageDebugInfo(item = {}, conversation = {}) {
  const meta = item.meta || {};
  return debugLines([
    ['type', 'pi_message'],
    ['message_id', item.id],
    ['role', item.role],
    ['conversation_id', meta.conversation_id || conversation.id],
    ['pi_session_id', meta.pi_session_id || conversation.pi_session_id],
    ['conversation_title', conversation.title],
    ['created_at', item.created_at],
  ]);
}

export async function copyPiDebugText(text, successText) {
  try {
    await copyTextToClipboard(text);
    message.success(successText);
  } catch (err) {
    message.error(err.message || '复制诊断信息失败');
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('当前浏览器不支持复制到剪贴板');
}
