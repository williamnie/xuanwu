import { message as toast } from '../../store/toastStore';
import { canCreateSession, PROJECT_REQUIRED_MESSAGE } from './newSessionGuards';
import { runsApi } from '../../api/runs.js';
import { sessionPayloadWithReferences } from './sessionReferences';
import { availableProviderModelValue } from './sessionOptions';
import { sessionIDFromCreateResult, sessionFromCreateResult, mergeRefreshedSessions, isSessionRunning } from './sessionPageRuntime';
import { clearSessionCommandState } from './sessionCommands';
import { useCallback } from 'react';

export default function useSessionCreation({
  sending,
  newSessionBlockedReason,
  newProviderStatus,
  sessionSettings,
  projectId,
  cwd,
  prompt,
  selectedProject,
  promptReferences,
  newSessionReferenceValidation,
  setSending,
  models,
  addOptimisticUserMessage,
  setSelectedId,
  setSessionRunning,
  setSessions,
  setLiveEvents,
  setPrompt,
  setPromptReferences,
  setPromptCommand,
  loadFirstPage,
  keepNewSessionRoute,
  navigateTo,
  sessions,
  ignorePropSelectionRef,
  setDetailError,
  setActiveView,
  autoSelectFirstSessionRef,
  setPromptCommandResult,
  setPromptCommandError,
}) {
  // 新建并启动会话
  const handleCreateNewSession = async (e) => {
    if (e) e.preventDefault();
    if (sending) return;
    if (newSessionBlockedReason) { toast.error(newSessionBlockedReason); return; }
    const selectedProviderStatus = (newProviderStatus?.providers || []).find(item => item.id === sessionSettings.provider) || {
      id: sessionSettings.provider,
      ready: false,
      available: false,
      readiness_reason: 'Coding tool readiness status is unavailable',
    };
    const guard = canCreateSession({
      projectId,
      cwd,
      prompt,
      selectedProject,
      providerId: sessionSettings.provider,
      providerStatus: selectedProviderStatus,
      references: promptReferences,
    });
    if (!guard.ok) {
      if (guard.reason === 'missing_project' || guard.reason === 'unsupported_provider' || guard.reason === 'provider_not_ready') {
        toast.error(guard.message || PROJECT_REQUIRED_MESSAGE);
      }
      return;
    }
    if (newSessionReferenceValidation.hasErrors) {
      toast.error(newSessionReferenceValidation.message);
      return;
    }
    setSending(true);
    try {
      const result = await runsApi.createSession(sessionPayloadWithReferences(prompt.trim(), {
        project_id: projectId,
        provider: sessionSettings.provider,
        cwd,
        model: availableProviderModelValue(sessionSettings.model, models),
        reasoning_effort: sessionSettings.reasoningEffort,
        service_tier: sessionSettings.serviceTier,
        approval_policy: sessionSettings.approvalPolicy,
        sandbox: sessionSettings.sandbox,
        execution_policy: sessionSettings.executionPolicy,
      }, promptReferences));
      const newSessionId = sessionIDFromCreateResult(result);
      const createdSession = sessionFromCreateResult(result, selectedProject);
      if (!newSessionId || !createdSession) throw new Error('编程工具 session 创建成功，但响应缺少有效 session ref');
      addOptimisticUserMessage(newSessionId, prompt.trim());
      setSelectedId(newSessionId);
      setSessionRunning(Boolean(result.turn_id || result.provider_turn_id));
      setSessions((prev) => mergeRefreshedSessions(prev, [{
        ...createdSession,
        preview: prompt.trim().replace(/\s+/g, ' ').slice(0, 120),
      }]));
      setLiveEvents([]);
      setPrompt('');
      setPromptReferences([]);
      setPromptCommand(clearSessionCommandState());
      await loadFirstPage({ preserveLoaded: true });
      if (keepNewSessionRoute) navigateTo?.('runs', null, '', '', { sessionId: newSessionId });
    } catch (err) {
      toast.error(err.message || '创建 session 失败');
    } finally {
      setSending(false);
    }
  };

  const selectSession = useCallback((id) => {
    const nextSession = sessions.find((item) => item.id === id);
    ignorePropSelectionRef.current = false;
    setSelectedId(id);
    setDetailError('');
    setActiveView('chat');
    setLiveEvents([]);
    setSessionRunning(isSessionRunning(nextSession));
    if (keepNewSessionRoute) navigateTo?.('runs', null, '', '', { sessionId: id });
  }, [ignorePropSelectionRef, keepNewSessionRoute, navigateTo, sessions, setActiveView, setDetailError, setLiveEvents, setSelectedId, setSessionRunning]);

  const openNewSession = useCallback(() => {
    ignorePropSelectionRef.current = true;
    autoSelectFirstSessionRef.current = false;
    if (!keepNewSessionRoute) navigateTo?.('sessions');
    setSelectedId('');
    setDetailError('');
    setActiveView('new');
    setPrompt('');
    setPromptCommand(clearSessionCommandState());
    setPromptCommandResult(null);
    setPromptCommandError('');
    setSessionRunning(false);
  }, [autoSelectFirstSessionRef, ignorePropSelectionRef, keepNewSessionRoute, navigateTo, setActiveView, setDetailError, setPrompt, setPromptCommand, setPromptCommandError, setPromptCommandResult, setSelectedId, setSessionRunning]);

  return { handleCreateNewSession, selectSession, openNewSession };
}
