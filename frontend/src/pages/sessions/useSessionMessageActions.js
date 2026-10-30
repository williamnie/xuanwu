import { useRef, useCallback, useEffect } from 'react';
import { queuedMessageId, isSessionRunning, setSessionRunningInList } from './sessionPageRuntime';
import { createOptimisticSessionUserMessage, reconcileOptimisticSessionUserMessages } from './sessionOptimisticMessages';
import { runsApi } from '../../api/runs.js';
import { sessionPayloadWithReferences, hasComposerContent } from './sessionReferences';
import { availableProviderModelValue } from './sessionOptions';
import { nextPendingQueuedSessionMessage, markQueuedSessionMessageSending, removeQueuedSessionMessage, markQueuedSessionMessageFailed, createQueuedSessionMessage, enqueueQueuedSessionMessage } from './sessionMessageQueue';
import { message as toast } from '../../store/toastStore';
import { isInterruptPendingForSession } from './sessionInterrupt';
import { clearSessionCommandState } from './sessionCommands';

export default function useSessionMessageActions({
  selectedSession,
  setOptimisticUserMessages,
  models,
  setSessionRunning,
  setSessions,
  setLiveEvents,
  loadSelected,
  messageQueueRef,
  setSending,
  setMessageQueue,
  selectedId,
  selectedDetailReady,
  sessionRunning,
  sending,
  interruptStateRef,
  messageQueue,
  message,
  messageReferences,
  canSteerSelected,
  followRunningTurn,
  messageReferenceValidation,
  messageCommand,
  messageSettings,
  currentQueuedMessages,
  setMessageCommand,
  setMessage,
  setMessageReferences,
}) {
  const activeQueuedSendsRef = useRef(new Set());
  const addOptimisticUserMessage = useCallback((sessionId, promptText, id = queuedMessageId()) => {
    const message = createOptimisticSessionUserMessage({
      id,
      sessionId,
      prompt: promptText,
      session: selectedSession?.id === sessionId ? selectedSession : null,
    });
    if (!message) return null;
    setOptimisticUserMessages((current) => [...current, message]);
    return message;
  }, [selectedSession, setOptimisticUserMessages]);

  const removeOptimisticUserMessage = useCallback((id) => {
    if (!id) return;
    setOptimisticUserMessages((current) => current.filter((message) => message.id !== id));
  }, [setOptimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((current) => reconcileOptimisticSessionUserMessages(current, selectedSession));
  }, [selectedSession, setOptimisticUserMessages]);

  const startSessionMessage = useCallback(async (sessionId, promptText, settings, references = []) => {
    const optimisticMessage = addOptimisticUserMessage(sessionId, promptText);
    try {
      const result = await runsApi.sendSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
        model: availableProviderModelValue(settings.model, models),
        reasoning_effort: settings.reasoningEffort,
        service_tier: settings.serviceTier,
        approval_policy: settings.approvalPolicy,
        sandbox: settings.sandbox,
        execution_policy: settings.executionPolicy,
      }, references));
      const running = isSessionRunning(result);
      setSessionRunning(running);
      setSessions((prev) => setSessionRunningInList(prev, sessionId, running));
      setLiveEvents([]);
      if (!running) await loadSelected(false);
    } catch (err) {
      removeOptimisticUserMessage(optimisticMessage?.id);
      throw err;
    }
  }, [addOptimisticUserMessage, loadSelected, models, removeOptimisticUserMessage, setLiveEvents, setSessionRunning, setSessions]);

  const steerSessionMessage = useCallback(async (sessionId, promptText, settings, references = []) => {
    await runsApi.steerSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
      model: availableProviderModelValue(settings.model, models),
      reasoning_effort: settings.reasoningEffort,
      service_tier: settings.serviceTier,
      approval_policy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      execution_policy: settings.executionPolicy,
    }, references));
  }, [models]);

  const sendQueuedMessage = useCallback(async (sessionId) => {
    const queued = nextPendingQueuedSessionMessage(messageQueueRef.current, sessionId);
    if (!queued || activeQueuedSendsRef.current.has(queued.id)) return;
    activeQueuedSendsRef.current.add(queued.id);
    setSending(true);
    setMessageQueue((current) => markQueuedSessionMessageSending(current, queued.id));
    try {
      await startSessionMessage(sessionId, queued.prompt, queued.settings, queued.references);
      setMessageQueue((current) => removeQueuedSessionMessage(current, queued.id));
    } catch (err) {
      setMessageQueue((current) => markQueuedSessionMessageFailed(current, queued.id, err.message || '发送排队消息失败'));
      toast.error(err.message || '发送排队消息失败');
    } finally {
      activeQueuedSendsRef.current.delete(queued.id);
      setSending(false);
    }
  }, [messageQueueRef, setMessageQueue, setSending, startSessionMessage]);

  useEffect(() => {
    if (!selectedId || !selectedDetailReady || sessionRunning || sending) return;
    if (isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    sendQueuedMessage(selectedId);
  }, [selectedId, selectedDetailReady, sessionRunning, sending, messageQueue, sendQueuedMessage, interruptStateRef]);

  const sendMessage = async (event) => {
    event.preventDefault();
    const promptText = message.trim();
    const referencesSnapshot = messageReferences;
    const wantsOppositeMode = Boolean(event.metaKey || event.ctrlKey);
    const shouldGuide = canSteerSelected && sessionRunning && (wantsOppositeMode ? !followRunningTurn : followRunningTurn);
    if (!selectedId || sending || isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    if (!hasComposerContent(promptText, messageReferences)) return;
    if (messageReferenceValidation.hasErrors) {
      toast.error(messageReferenceValidation.message);
      return;
    }
    if (messageCommand) {
      toast.error('Command 请使用 command 面板执行，不会作为普通 prompt 发送。');
      return;
    }
    if (shouldGuide) {
      const optimisticMessage = addOptimisticUserMessage(selectedId, promptText);
      setSending(true);
      clearMessageDraft();
      try {
        await steerSessionMessage(selectedId, promptText, messageSettings, messageReferences);
        toast.info('已引导当前响应。');
      } catch (err) {
        removeOptimisticUserMessage(optimisticMessage?.id);
        restoreMessageDraft(promptText, referencesSnapshot);
        toast.error(err.message || '引导当前响应失败');
      } finally {
        setSending(false);
      }
      return;
    }
    if (sessionRunning || currentQueuedMessages.length > 0) {
      const queued = createQueuedSessionMessage({
        id: queuedMessageId(),
        sessionId: selectedId,
        prompt: promptText,
        references: messageReferences,
        settings: messageSettings,
      });
      setMessageQueue((current) => enqueueQueuedSessionMessage(current, queued));
      clearMessageDraft();
      toast.info(sessionRunning ? '已排队为下一条消息。' : '已追加到消息队列。');
      return;
    }
    setSending(true);
    clearMessageDraft();
    try {
      await startSessionMessage(selectedId, promptText, messageSettings, messageReferences);
      setMessageCommand(clearSessionCommandState());
    } catch (err) {
      restoreMessageDraft(promptText, referencesSnapshot);
      toast.error(err.message || '发送消息失败');
    } finally {
      setSending(false);
    }
  };

  const clearMessageDraft = () => {
    setMessage('');
    setMessageReferences([]);
  };

  const restoreMessageDraft = (promptText, references = []) => {
    setMessage((current) => current.trim() ? current : promptText);
    setMessageReferences((current) => current.length > 0 ? current : references);
  };

  return { addOptimisticUserMessage, sendMessage };
}
