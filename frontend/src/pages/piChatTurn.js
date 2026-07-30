export function createPiChatTurnManager() {
  let current = null;
  return {
    begin(conversationId) {
      cancelCurrent('replaced');
      current = {
        cancelReason: '',
        controller: new AbortController(),
        conversationId,
        ignored: false,
      };
      return current;
    },
    cancel: cancelCurrent,
    current: () => current,
    finish(turn) {
      if (current !== turn) return false;
      current = null;
      return true;
    },
    isCurrent: (turn) => current === turn && !turn.ignored,
  };

  function cancelCurrent(reason = 'cancelled') {
    const turn = current;
    if (!turn) return null;
    turn.cancelReason = reason;
    turn.ignored = true;
    current = null;
    turn.controller.abort();
    return turn;
  }
}

export function appendPiTurnDelta(items, turnId, delta, conversationId) {
  const text = String(delta || '');
  const id = `pi-turn-${String(turnId || '').trim()}`;
  if (!text || id === 'pi-turn-') return Array.isArray(items) ? items : [];
  const current = Array.isArray(items) ? items : [];
  let updated = false;
  const next = current.map((item) => {
    if (item.id !== id) return item;
    updated = true;
    return { ...item, text: `${item.text || ''}${text}` };
  });
  if (updated) return next;
  return [...current, {
    id,
    role: 'assistant',
    text,
    meta: {
      conversation_id: conversationId,
      live: true,
      turn_id: turnId,
    },
  }];
}

export function replacePiTurnText(items, turnId, text, conversationId) {
  const value = String(text || '');
  const id = `pi-turn-${String(turnId || '').trim()}`;
  const current = Array.isArray(items) ? items : [];
  if (!value || id === 'pi-turn-') return current;
  const liveItem = {
    id,
    role: 'assistant',
    text: value,
    meta: {
      conversation_id: conversationId,
      live: true,
      turn_id: turnId,
    },
  };
  const index = current.findIndex((item) => item.id === id);
  if (index === -1) return [...current, liveItem];
  return current.map((item, itemIndex) => itemIndex === index ? { ...item, ...liveItem } : item);
}

export async function hydrateCompletedPiTurn(options) {
  const detail = await options.getConversation(options.conversationId);
  if (!options.isCurrent()) return false;
  options.onHydrated(detail);
  return true;
}
