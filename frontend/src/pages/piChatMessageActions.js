import { assistantApi } from '../api/assistant.js';
import { PiConversationStreamError } from '../api/piConversationStream.js';
import { useCallback } from 'react';
import { message } from '../store/toastStore';
import { piChatMessageWithProjectContext, projectFromPrompt } from './piChatProjectContext';
import { applyPiConversationActivityEvent, conversationTranscript } from './piChatRuntimeState';
import { appendPiTurnDelta, hydrateCompletedPiTurn } from './piChatTurn';

const STOP_RETRY_COUNT = 4;

const STOP_RETRY_DELAY_MS = 160;

export function useCreatePiConversation(state) {
  return useCallback(async (title, options = {}) => {
    state.setSending(true);
    try {
      const conversation = await assistantApi.createPiConversation({
        project_id: currentProjectId(state, options.project),
        title
      });
      state.setConversations((items) => [conversation, ...items]);
      state.setSelectedConversationId(conversation.id);
      state.notifyConversationChange(conversation.id);
      state.setTranscript([]);
      state.setReferences([]);
      if (options.notify) message.success('Chat 已创建');
      return conversation.id;
    } catch {
      message.error('创建 Chat 失败，请重试');
      return '';
    } finally {
      state.setSending(false);
    }
  }, [state]);
}

export function useSendPiMessage(state, createConversation, loadPiState, turnManager) {
  return useCallback(async (event) => {
    event.preventDefault();
    const text = state.prompt.trim();
    if (!text || state.sending) return;
    const targetProject = state.selectedProject || projectFromPrompt(text, state.projects);
    const conversationId = state.selectedConversationId
      || await createConversation('New conversation', { project: targetProject });
    if (!conversationId) return;
    await sendPromptToPi(state, conversationId, text, loadPiState, targetProject, turnManager);
  }, [createConversation, loadPiState, state, turnManager]);
}

export function useStopPiMessage(state, turnManager) {
  return useCallback(async () => {
    const conversationId = state.runningConversationId;
    if (!state.sending || !conversationId || state.stopping) return;
    state.setStopping(true);
    try {
      const result = await interruptActivePiConversation(conversationId);
      if (result?.interrupted) {
        turnManager.cancel('stop');
        clearPiTurnState(state);
        message.success('已请求停止 Xuanwu');
        return;
      }
      state.setStopping(false);
      message.error('当前没有可停止的 Xuanwu 执行');
    } catch {
      state.setStopping(false);
      message.error('停止 Xuanwu 失败，请重试');
    }
  }, [state, turnManager]);
}

async function sendPromptToPi(state, conversationId, text, loadPiState, targetProject, turnManager) {
  const turn = turnManager.begin(conversationId);
  let backgroundRunning = false;
  state.setTranscript((items) => [...items, transcriptMessage('user', text)]);
  state.setPrompt('');
  state.setReferences([]);
  state.setRunningConversationId(conversationId);
  state.setSending(true);
  try {
    const result = await assistantApi.sendPiConversationMessage(
      conversationId,
      piChatMessageWithProjectContext(text, targetProject || state.selectedProject),
      {
        signal: turn.controller.signal,
        onEvent: (streamEvent) => applyPiTurnEvent(state, turnManager, turn, streamEvent),
      },
    );
    if (!turnManager.isCurrent(turn) || result?.status === 'aborted') return;
    applyConversationTitle(state, conversationId, result?.title);
    await hydrateConversationTranscript(
      state,
      conversationId,
      result,
      () => turnManager.isCurrent(turn),
    );
    if (!turnManager.isCurrent(turn)) return;
    await loadPiState({ background: true });
  } catch (err) {
    if (!turnManager.isCurrent(turn)) return;
    backgroundRunning = Boolean(err?.backgroundRunning);
    const detail = piTurnErrorMessage(err);
    state.setTranscript((items) => [...items, transcriptMessage('error', detail, {
      background_running: Boolean(err?.backgroundRunning),
      recoverable: true,
      turn_id: err?.turnId || '',
    })]);
    if (backgroundRunning) {
      state.setRunningConversationId(conversationId);
      state.setSending(true);
      await loadPiState({ background: true });
    }
    message.error(detail);
  } finally {
    if (turnManager.finish(turn) && !backgroundRunning) clearPiTurnState(state);
  }
}

function applyPiTurnEvent(state, turnManager, turn, streamEvent) {
  if (!turnManager.isCurrent(turn)) return;
  const { data, event, turnId } = streamEvent;
  if (event === 'accepted' || event === 'start') {
    state.setSending(true);
    state.setConversations((items) => applyPiConversationActivityEvent(items, {
      agent_event_type: 'agent_start',
      conversationId: turn.conversationId,
      turnId,
      type: 'pi.conversation.event',
    }));
    return;
  }
  if (event === 'assistant_text_delta') {
    state.setTranscript((items) => appendPiTurnDelta(items, turnId, data.delta ?? data.text, turn.conversationId));
  }
}

export function clearPiTurnState(state) {
  state.setRunningConversationId('');
  state.setSending(false);
  state.setStopping(false);
}

function piTurnErrorMessage(error) {
  if (error instanceof PiConversationStreamError) return error.message;
  if (error?.name === 'AbortError') return '消息流已关闭';
  return error?.message || '发送失败，请重试';
}

async function interruptActivePiConversation(conversationId) {
  let result = null;
  for (let attempt = 0; attempt <= STOP_RETRY_COUNT; attempt += 1) {
    result = await assistantApi.interruptPiConversation(conversationId);
    if (result?.interrupted || attempt === STOP_RETRY_COUNT) return result;
    await delay(STOP_RETRY_DELAY_MS);
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateConversationTranscript(state, conversationId, fallbackResult = null, shouldApply = () => true) {
  try {
    await hydrateCompletedPiTurn({
      conversationId,
      getConversation: assistantApi.getPiConversation,
      isCurrent: shouldApply,
      onHydrated(detail) {
        state.setTranscript(conversationTranscript(detail));
        state.setError('');
      },
    });
  } catch {
    if (!shouldApply()) return;
    const text = runnerReplyText(fallbackResult);
    if (text) state.setTranscript((items) => [...items, transcriptMessage('assistant', text, fallbackResult)]);
  }
}

function applyConversationTitle(state, conversationId, title) {
  const text = String(title || '').trim();
  if (!text) return;
  state.setConversations((items) => items.map((item) => (
    item.id === conversationId ? { ...item, title: text } : item
  )));
}

function runnerReplyText(result) {
  const text = String(result?.text || '').trim();
  if (text) return text;
  if (result?.status === 'failed') return 'Xuanwu 执行失败，未返回错误详情';
  return 'Xuanwu 未返回内容';
}

function currentProjectId(state, project = null) {
  return project?.id || state.selectedProject?.id || '';
}

function transcriptMessage(role, text, meta = null) {
  return { created_at: new Date().toISOString(), id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, meta, role, text };
}
