import { hasApprovalForSession } from './sessions/approvalQueue';
import { readySessionProviders } from './sessions/newSessionGuards';
import SessionSidebar from './sessions/SessionSidebar';
import SessionWorkspace from './sessions/SessionWorkspace';
import useSessionsController from './sessions/useSessionsController.js';
import './sessions/Sessions.css';
import './sessions/SessionsClient.css';

export default function Sessions({
  autoSelectFirstSession = true,
  navigateTo,
  observationNotice = '',
  selectedSessionId = '',
  showEvidence = true,
  showSidebar = true,
  keepNewSessionRoute = false,
  loadTranscriptPage,
}) {
  const {
    activeView,
    cursor,
    loading,
    sessions,
    loadingMore,
    projects,
    savingProjectOrder,
    selectedId,
    loadMore,
    openNewSession,
    handleReorderProjects,
    selectSession,
    detailLoading,
    detailError,
    turnCursor,
    loadOlderTurns,
    selectedSession,
    turnsLoading,
    selectedSessionProject,
    liveEvents,
    sessionRunning,
    optimisticUserMessages,
    approvalQueue,
    approvalRequest,
    approvalSubmitting,
    currentApprovals,
    resolveApproval,
    message,
    setMessage,
    messageSettings,
    handleMessageSettingChange,
    models,
    modelsLoading,
    modelsError,
    providerCatalog,
    sending,
    interruptState,
    currentQueuedMessages,
    canSteerSelected,
    followRunningTurn,
    setFollowRunningTurn,
    sessionComposerSuggestions,
    messageReferenceDetails,
    setMessageReferences,
    messageReferenceValidation,
    messageCommand,
    messageCommandContext,
    commandExecuting,
    messageCommandResult,
    messageCommandError,
    setMessageCommand,
    setMessageCommandResult,
    setMessageCommandError,
    executeMessageCommand,
    sendMessage,
    interrupt,
    cancelQueuedMessage,
    retryQueuedMessage,
    selectedProject,
    prompt,
    setPrompt,
    promptCommand,
    newCommandContext,
    promptCommandResult,
    promptCommandError,
    executeNewSessionCommand,
    setPromptCommand,
    setPromptCommandError,
    setPromptCommandResult,
    newSessionReferenceDetails,
    promptReferences,
    setPromptReferences,
    newSessionReferenceValidation,
    handleCreateNewSession,
    sessionSettings,
    handleSettingChange,
    projectId,
    handleProjectChange,
    sessionProjects,
    newProviderStatus,
    newProviderCatalog,
    newSessionBlockedReason,
  } = useSessionsController({
    autoSelectFirstSession, navigateTo, observationNotice, selectedSessionId, showEvidence, showSidebar, keepNewSessionRoute, loadTranscriptPage,
  });
  return (
    <>
      {showSidebar ? (
        <SessionSidebar
          activeView={activeView}
          cursor={cursor}
          loading={loading && sessions.length === 0}
          loadingMore={loadingMore}
          projects={projects}
          savingProjectOrder={savingProjectOrder}
          selectedId={selectedId}
          sessions={sessions}
          onLoadMore={loadMore}
          onNewSession={openNewSession}
          onReorderProjects={handleReorderProjects}
          onSelectSession={selectSession}
        />
      ) : null}
      <SessionWorkspace
        loading={loading && sessions.length === 0}
        activeView={activeView}
        chatProps={{
          detailLoading,
          detailError,
          hasOlderTurns: Boolean(turnCursor),
          loadOlderTurns,
          selectedSession,
          turnsLoading,
          selectedSessionProject,
          liveEvents,
          sessionRunning,
          optimisticUserMessages,
          pendingApproval: hasApprovalForSession(approvalQueue, selectedId),
          observationNotice,
          showEvidence,
          navigateTo,
          approvalRequest,
          approvalSubmitting,
          currentApprovals,
          resolveApproval,
          message,
          setMessage,
          messageSettings,
          handleMessageSettingChange,
          models,
          modelsLoading,
          modelsError,
          providerCatalog,
          sending,
          interruptState,
          selectedId,
          currentQueuedMessages,
          followRunningTurn: canSteerSelected && followRunningTurn,
          setFollowRunningTurn: canSteerSelected ? setFollowRunningTurn : null,
          sessionComposerSuggestions,
          messageReferenceDetails,
          setMessageReferences,
          messageReferenceValidation,
          messageCommand,
          messageCommandContext,
          commandExecuting,
          messageCommandResult,
          messageCommandError,
          setMessageCommand,
          setMessageCommandResult,
          setMessageCommandError,
          executeMessageCommand,
          sendMessage,
          interrupt,
          cancelQueuedMessage,
          retryQueuedMessage,
        }}
        newSessionProps={{
          selectedProject,
          prompt,
          setPrompt,
          promptCommand,
          newCommandContext,
          commandExecuting,
          promptCommandResult,
          promptCommandError,
          executeNewSessionCommand,
          setPromptCommand,
          setPromptCommandError,
          setPromptCommandResult,
          sessionComposerSuggestions,
          newSessionReferenceDetails,
          promptReferences,
          setPromptReferences,
          sending,
          newSessionReferenceValidation,
          handleCreateNewSession,
          sessionSettings,
          handleSettingChange,
          models,
          modelsError,
          modelsLoading,
          projectId,
          handleProjectChange,
          sessionProjects,
          providerOptions: readySessionProviders(newProviderStatus),
          providerCatalog: newProviderCatalog,
          blockedReason: newSessionBlockedReason,
        }}
      />
    </>
  );
}
