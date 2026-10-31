import { availableProviderModels, availableProviderModelValue, serviceTierOptions } from './sessionOptions';
import { visibleEffortOptions } from './sessionComposerLabels.js';
import { RuntimeControls } from './SessionRuntimeControls.jsx';
import { QueueStatus, InterruptStatus } from './SessionComposerStatus.jsx';
import PromptEditor from '../../components/editor/PromptEditor';
import SessionCommandPanel from './SessionCommandPanel';
import { ComposerActions } from './SessionComposerActions.jsx';
import './SessionComposer.css';

export default function SessionComposer({
  value,
  onChange,
  settings,
  onSettingChange,
  models,
  modelsLoading,
  modelsError,
  sending,
  running,
  interruptState,
  selectedId,
  placeholder = "给当前编程工具 session 发送消息...",
  queuedMessages = [],
  followMode = true,
  onFollowModeChange = null,
  onSubmit,
  onStop,
  onCancelQueuedMessage,
  onRetryQueuedMessage,
  suggestions = [],
  referenceDetails = [],
  showReferenceChips = true,
  onAttachReference = null,
  onRemoveReference = null,
  hasInvalidReferences = false,
  commandState = null,
  commandContext = {},
  commandExecuting = false,
  commandResult = null,
  commandError = '',
  onSelectCommand = null,
  onExecuteCommand = null,
  onCancelCommand = null,
  runtimeControls = null,
  providerCatalog = [],
  requirePrompt = false,
}) {
  const selectableModels = availableProviderModels(models);
  const selectedModelValue = availableProviderModelValue(settings.model, selectableModels);
  const selectedModel = selectableModels.find((model) => model.id === selectedModelValue || model.model === selectedModelValue);
  const defaultModel = selectableModels.find((model) => model.isDefault) || selectableModels[0] || null;
  const effectiveModel = selectedModel || defaultModel;
  const effortOptions = visibleEffortOptions(effectiveModel, settings.reasoningEffort, settings.provider);
  const tierOptions = serviceTierOptions(effectiveModel, settings.serviceTier);
  const composerRuntimeControls = runtimeControls ?? (
    <RuntimeControls
      settings={settings}
      onSettingChange={onSettingChange}
      models={selectableModels}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      effortOptions={effortOptions}
      tierOptions={tierOptions}
      effectiveModel={effectiveModel}
      providerCatalog={providerCatalog}
    />
  );
  const hasQueuedMessages = queuedMessages.length > 0;
  const interrupting = isInterruptPending(interruptState, selectedId);
  const hasCommand = Boolean(commandState);
  const hasContent = Boolean(value.trim() || (!requirePrompt && referenceDetails.length) || hasCommand);
  const canSubmitMessage = Boolean(selectedId && hasContent && !hasCommand && !hasInvalidReferences && !sending && !interrupting);
  const submitFromEditor = (event) => onSubmit({
    preventDefault() {},
    metaKey: Boolean(event?.metaKey),
    ctrlKey: Boolean(event?.ctrlKey),
  });
  return (
    <form className="session-composer" onSubmit={onSubmit}>
      <QueueStatus
        queuedMessages={queuedMessages}
        onCancel={onCancelQueuedMessage}
        onRetry={onRetryQueuedMessage}
      />
      <InterruptStatus interruptState={interruptState} selectedId={selectedId} />
      <SessionCommandPanel
        commandState={commandState}
        context={commandContext}
        executing={commandExecuting}
        result={commandResult}
        error={commandError}
        onExecute={onExecuteCommand}
        onCancel={onCancelCommand}
      />
      <PromptEditor
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        minHeight={84}
        variant="composer"
        footerControls={composerRuntimeControls}
        onSubmitKey={canSubmitMessage ? submitFromEditor : null}
        suggestions={suggestions}
        referenceDetails={referenceDetails}
        showReferenceChips={showReferenceChips}
        onAttachReference={onAttachReference}
        onRemoveReference={onRemoveReference}
        onSelectCommand={onSelectCommand}
        actions={(
          <ComposerActions
            sending={sending}
            running={running}
            interrupting={interrupting}
            selectedId={selectedId}
            canSend={!hasCommand && hasContent && !hasInvalidReferences}
            hasQueuedMessages={hasQueuedMessages}
            followMode={followMode}
            onFollowModeChange={onFollowModeChange}
            onStop={onStop}
          />
        )}
      />
    </form>
  );
}

function isInterruptPending(interruptState, selectedId) {
  return interruptState?.sessionId === selectedId && interruptState?.status === 'pending';
}
