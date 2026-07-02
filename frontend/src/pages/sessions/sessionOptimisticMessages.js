import { textFromUserContent } from './sourceIssue.js';

export function createOptimisticSessionUserMessage({ id, sessionId, prompt, session = null, createdAt = '' }) {
  const text = normalizeMessageText(prompt);
  if (!id || !sessionId || !text) return null;
  return {
    id,
    sessionId,
    prompt: text,
    createdAt: createdAt || new Date().toISOString(),
    persistedCountBefore: countPersistedUserMessages(session, text),
  };
}

export function reconcileOptimisticSessionUserMessages(messages, session) {
  if (!Array.isArray(messages) || !session?.id) return Array.isArray(messages) ? messages : [];
  return messages.filter((message) => {
    if (message.sessionId !== session.id) return true;
    return countPersistedUserMessages(session, message.prompt) <= Number(message.persistedCountBefore || 0);
  });
}

export function countPersistedUserMessages(session, prompt) {
  const target = normalizeMessageText(prompt);
  if (!target) return 0;
  return persistedUserTexts(session).filter((text) => text === target).length;
}

function persistedUserTexts(session) {
  if (!Array.isArray(session?.turns)) return [];
  return session.turns.flatMap((turn) => userTextsFromTurn(turn));
}

function userTextsFromTurn(turn) {
  if (!Array.isArray(turn?.items)) return [];
  return turn.items
    .filter((item) => item?.type === 'userMessage')
    .map((item) => normalizeMessageText(textFromUserContent(item.content)))
    .filter(Boolean);
}

function normalizeMessageText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}
