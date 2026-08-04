const MAX_RELATED_WORK_LINKS = 8;
const PLACEHOLDER_TITLES = new Set(['', 'New conversation', 'Runner']);

export function displayPiConversationTitle(conversation = null, t = null) {
  const title = cleanText(conversation?.title);
  if (PLACEHOLDER_TITLES.has(title)) return copy(t, 'chat.new', 'New chat');
  if (/^Feishu\s*·\s*(?:oc_|ou_|om_|chat[-_:])/i.test(title)) return copy(t, 'chat.feishuChat', 'Feishu chat');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)) return copy(t, 'chat.chat', 'Chat');
  return title;
}

export function piChatStatusSummary({ conversation = null, error = '', loading = false, sending = false, t = null, transcript = [] } = {}) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const detail = messageCountLabel(messages.length, t);
  if (error) return { detail: copy(t, 'chat.status.retryDetail', '可重试或复制 Debug 信息'), label: copy(t, 'chat.status.retry', '需要重试'), tone: 'error' };
  if (loading) return { detail: copy(t, 'chat.status.loadingDetail', '正在读取对话记录'), label: copy(t, 'chat.status.loading', '载入中'), tone: 'running' };
  if (sending || conversation?.runtime_status === 'running') return { detail: copy(t, 'chat.status.sendingDetail', 'Xuanwu 正在更新此 Chat'), label: copy(t, 'chat.status.sending', '处理中'), tone: 'running' };
  if (!conversation) return { detail: copy(t, 'chat.status.startDetail', '开始新的 Chat'), label: copy(t, 'chat.status.ready', '准备就绪'), tone: 'idle' };
  if (messages.at(-1)?.role === 'error' || ['error', 'failed'].includes(cleanText(conversation.status).toLowerCase())) {
    return { detail: copy(t, 'chat.status.incompleteDetail', '可重试或继续说明'), label: copy(t, 'chat.status.incomplete', '上次未完成'), tone: 'error' };
  }
  if (['archived', 'closed'].includes(cleanText(conversation.status).toLowerCase())) {
    return { detail, label: copy(t, 'chat.status.archived', '已归档'), tone: 'idle' };
  }
  if (messages.length === 0) return { detail: copy(t, 'chat.status.waitingDetail', '等待你的目标'), label: copy(t, 'chat.status.waiting', '等待输入'), tone: 'idle' };
  return { detail, label: copy(t, 'chat.status.updated', '已更新'), tone: 'ready' };
}

export function sortPiConversationsByActivity(conversations = []) {
  return [...(Array.isArray(conversations) ? conversations : [])].sort((left, right) => {
    const leftRunning = left?.runtime_status === 'running';
    const rightRunning = right?.runtime_status === 'running';
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    const leftActivity = cleanText(left?.last_activity_at || left?.updated_at || left?.created_at);
    const rightActivity = cleanText(right?.last_activity_at || right?.updated_at || right?.created_at);
    return rightActivity.localeCompare(leftActivity) || cleanText(left?.id).localeCompare(cleanText(right?.id));
  });
}

export function isPiConversationArchived(conversation = null) {
  return ['archived', 'closed'].includes(cleanText(conversation?.status).toLowerCase());
}

export function visiblePiConversations(conversations = []) {
  return (Array.isArray(conversations) ? conversations : []).filter((conversation) => !isPiConversationArchived(conversation));
}

export function piChatWorkLinks(transcript = []) {
  const links = new Map();
  for (const item of Array.isArray(transcript) ? transcript : []) {
    addMetadataWorkLinks(links, item?.meta);
    addTextWorkLinks(links, item?.text);
    if (links.size >= MAX_RELATED_WORK_LINKS) break;
  }
  return [...links.values()].slice(0, MAX_RELATED_WORK_LINKS);
}

function addMetadataWorkLinks(links, meta) {
  if (!meta || typeof meta !== 'object') return;
  asArray(meta.work_id).concat(asArray(meta.work_ids)).forEach(value => addCanonicalWorkLink(links, value));
  asArray(meta.issue_id).concat(asArray(meta.issue_ids)).forEach(value => addIssueWorkLink(links, value));
}

function addTextWorkLinks(links, value) {
  const text = cleanText(value);
  if (!text) return;
  for (const match of text.matchAll(/\bxw:work:[a-z0-9_-]+:[a-z0-9._-]+\b/gi)) {
    addCanonicalWorkLink(links, match[0]);
  }
  for (const match of text.matchAll(/(?:\bWork\b|\bissue\b)\s*#?\s*([1-9]\d*)\b/gi)) {
    addIssueWorkLink(links, match[1]);
  }
  for (const match of text.matchAll(/(^|[^\w])#([1-9]\d*)\b/g)) {
    addIssueWorkLink(links, match[2]);
  }
}

function addCanonicalWorkLink(links, value) {
  const id = cleanText(value);
  if (!/^xw:work:[a-z0-9_-]+:[a-z0-9._-]+$/i.test(id) || links.has(id)) return;
  const issueMatch = /^xw:work:issues:([1-9]\d*)$/i.exec(id);
  links.set(id, { id, label: issueMatch ? `Work #${issueMatch[1]}` : compactWorkLabel(id) });
}

function addIssueWorkLink(links, value) {
  const issueID = Number(value);
  if (!Number.isSafeInteger(issueID) || issueID <= 0) return;
  addCanonicalWorkLink(links, `xw:work:issues:${issueID}`);
}

function compactWorkLabel(id) {
  const suffix = id.split(':').at(-1) || id;
  return `Work ${suffix.length > 18 ? `${suffix.slice(0, 9)}…${suffix.slice(-6)}` : suffix}`;
}

function messageCountLabel(count, t) {
  return count > 0 ? copy(t, 'chat.status.messageCount', `${count} 条消息`, { count }) : copy(t, 'chat.status.noMessages', '暂无消息');
}

function copy(t, key, fallback, variables) {
  return typeof t === 'function' ? t(key, variables) : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
}

function cleanText(value) {
  return String(value ?? '').trim();
}
