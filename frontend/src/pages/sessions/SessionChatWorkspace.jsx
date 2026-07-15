import TurtleLoader from '../../components/TurtleLoader';
import ApprovalDialog from './ApprovalDialog';
import SessionComposer from './SessionComposer';
import SessionTranscript from './SessionTranscript';
import { addSessionReference, removeSessionReference } from './sessionReferences';
import { clearSessionCommandState, createSessionCommandState } from './sessionCommands';

export default function SessionChatWorkspace({
  detailLoading,
  selectedSession,
  selectedSessionProject,
  liveEvents,
  sessionRunning,
  optimisticUserMessages,
  pendingApproval,
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
  sending,
  interruptState,
  selectedId,
  currentQueuedMessages,
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
}) {
  return (
    <div className="active-session-shell">
      <div className="client-chat-area">
        {detailLoading ? (
          <div className="session-detail-loading">
            <TurtleLoader label="玄武正在翻阅会话记录…" />
          </div>
        ) : selectedSession ? (
          <SessionTranscript
            session={selectedSession}
            project={selectedSessionProject}
            liveEvents={liveEvents}
            running={sessionRunning}
            optimisticUserMessages={optimisticUserMessages}
            pendingApproval={pendingApproval}
            navigateTo={navigateTo}
          />
        ) : (
          <div className="session-empty">选择一个 provider session 查看历史，或创建新 session。</div>
        )}

        <div className="client-chat-composer-section">
          <ApprovalDialog
            request={approvalRequest}
            submitting={approvalSubmitting}
            queueCount={currentApprovals.length}
            onResolve={resolveApproval}
          />
          <SessionComposer
            value={message}
            onChange={setMessage}
            settings={messageSettings}
            onSettingChange={handleMessageSettingChange}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            sending={sending}
            running={sessionRunning}
            interruptState={interruptState}
            selectedId={selectedId}
            queuedMessages={currentQueuedMessages}
            followMode={followRunningTurn}
            onFollowModeChange={setFollowRunningTurn}
            suggestions={sessionComposerSuggestions}
            referenceDetails={messageReferenceDetails}
            onAttachReference={(reference) => setMessageReferences((current) => addSessionReference(current, reference))}
            onRemoveReference={(key) => setMessageReferences((current) => removeSessionReference(current, key))}
            hasInvalidReferences={messageReferenceValidation.hasErrors}
            commandState={messageCommand}
            commandContext={messageCommandContext}
            commandExecuting={commandExecuting}
            commandResult={messageCommandResult}
            commandError={messageCommandError}
            onSelectCommand={(command) => {
              setMessageCommand(createSessionCommandState(command));
              setMessageCommandResult(null);
              setMessageCommandError('');
            }}
            onExecuteCommand={executeMessageCommand}
            onCancelCommand={() => {
              setMessageCommand(clearSessionCommandState());
              setMessageCommandError('');
            }}
            onSubmit={sendMessage}
            onStop={interrupt}
            onCancelQueuedMessage={cancelQueuedMessage}
            onRetryQueuedMessage={retryQueuedMessage}
          />
        </div>
      </div>
    </div>
  );
}
