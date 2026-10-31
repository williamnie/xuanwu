import SessionComposer from './sessions/SessionComposer';
import PiChatComposerMeta from './PiChatComposerMeta';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer';
import { projectFromPrompt } from './piChatProjectContext';
import { useI18n } from '../i18n/context.js';

const PI_CHAT_COMPOSER_SETTINGS = { model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'workspace-write' };

export function ChatComposer({ state }) {
  const { t } = useI18n();
  const messageRunning = Boolean(state.sending && state.runningConversationId);
  const selectedId = state.runningConversationId || state.selectedConversationId || 'runner-draft';
  return (
    <div className="pi-chat-composer">
      <SessionComposer
        value={state.prompt}
        onChange={state.setPrompt}
        settings={PI_CHAT_COMPOSER_SETTINGS}
        onSettingChange={() => {}}
        models={[]}
        modelsLoading={false}
        modelsError=""
        sending={state.sending}
        running={messageRunning}
        interruptState={messageRunning ? piChatInterruptState(state, selectedId, t) : null}
        selectedId={selectedId}
        placeholder={t('chat.placeholder')}
        onSubmit={state.handleSend}
        suggestions={buildPiChatProjectSuggestions(state.projects)}
        referenceDetails={buildPiChatReferenceDetails(state.references, state.projects)}
        showReferenceChips={false}
        onAttachReference={state.attachReference}
        onRemoveReference={state.removeReference}
        runtimeControls={<PiChatComposerMeta project={composerProject(state)} supervisor={state.supervisor} />}
        onStop={state.handleStop}
      />
    </div>
  );
}

function composerProject(state) {
  const hasProjectReference = state.references.some((reference) => reference.type === 'project');
  if (hasProjectReference) return state.selectedProject;
  if (!state.prompt.trim()) return null;
  return projectFromPrompt(state.prompt, state.projects);
}

function piChatInterruptState(state, selectedId, t) {
  if (!state.stopping) return null;
  return {
    sessionId: selectedId,
    status: 'pending',
    text: t('chat.stopping'),
    tone: 'info'
  };
}
