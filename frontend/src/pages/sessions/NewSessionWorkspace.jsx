import { ArrowUp, Brain, Folder, Gauge, Loader2, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import PromptEditor from '../../components/editor/PromptEditor';
import SessionCommandPanel from './SessionCommandPanel';
import { clearSessionCommandState, createSessionCommandState } from './sessionCommands';
import {
  modelLabel,
  providerLabel as projectProviderLabel,
  serviceTierOptions,
} from './sessionOptions';
import { addSessionReference, hasComposerContent, removeSessionReference } from './sessionReferences';

export default function NewSessionWorkspace({
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
  providerOptions = [],
}) {
  return (
    <div className="new-session-container animate-fade-in">
      <div className="new-session-center-card">
        <h1 className="new-session-title">
          我们应该在 {selectedProject?.name || '当前工作区'} 中构建什么？
        </h1>

        <div className="new-session-composer-wrapper">
          <SessionCommandPanel
            commandState={promptCommand}
            context={newCommandContext}
            executing={commandExecuting}
            result={promptCommandResult}
            error={promptCommandError}
            onExecute={executeNewSessionCommand}
            onCancel={() => {
              setPromptCommand(clearSessionCommandState());
              setPromptCommandError('');
            }}
          />
          <PromptEditor
            value={prompt}
            onChange={setPrompt}
            placeholder="尽管问"
            minHeight={80}
            variant="composer"
            suggestions={sessionComposerSuggestions}
            referenceDetails={newSessionReferenceDetails}
            onAttachReference={(reference) => setPromptReferences((current) => addSessionReference(current, reference))}
            onRemoveReference={(key) => setPromptReferences((current) => removeSessionReference(current, key))}
            onSelectCommand={(command) => {
              setPromptCommand(createSessionCommandState(command));
              setPromptCommandResult(null);
              setPromptCommandError('');
            }}
            onSubmitKey={!promptCommand && !sending && hasComposerContent(prompt, promptReferences) && !newSessionReferenceValidation.hasErrors ? handleCreateNewSession : null}
            footerControls={(
              <NewSessionPermissionControl
                settings={sessionSettings}
                onSettingChange={handleSettingChange}
              />
            )}
            actions={(
              <NewSessionComposerActions
                settings={sessionSettings}
                models={models}
                modelsError={modelsError}
                modelsLoading={modelsLoading}
                sending={sending}
                canSubmit={!promptCommand && hasComposerContent(prompt, promptReferences) && !newSessionReferenceValidation.hasErrors}
                onModelChange={(value) => handleSettingChange('model', value)}
                onServiceTierChange={(value) => handleSettingChange('serviceTier', value)}
                onSubmit={handleCreateNewSession}
              />
            )}
          />
        </div>

        <div className="new-session-bottom-tags">
          <div className="bottom-tag-select">
            <Folder size={13} />
            <span>项目: {selectedProject?.name || '未选择'}</span>
            <select value={projectId} onChange={(event) => handleProjectChange(event.target.value)}>
              <option value="">选择项目</option>
              {sessionProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>

          <div className="bottom-tag-select">
            <SlidersHorizontal size={13} />
            <span>Provider: {projectProviderLabel(sessionSettings.provider)}</span>
            <select value={sessionSettings.provider} onChange={(event) => handleSettingChange('provider', event.target.value)}>
              {!providerOptions.some(option => option.id === sessionSettings.provider) ? (
                <option value={sessionSettings.provider}>{projectProviderLabel(sessionSettings.provider)}（未就绪）</option>
              ) : null}
              {providerOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>

          <div className="bottom-tag-select">
            <SlidersHorizontal size={13} />
            <span>沙箱: {sessionSettings.sandbox === 'danger-full-access' ? '完全访问模式' : '安全沙箱'}</span>
            <select value={sessionSettings.sandbox} onChange={(event) => handleSettingChange('sandbox', event.target.value)}>
              <option value="workspace-write">本地安全沙箱</option>
              <option value="danger-full-access">完全访问模式</option>
              <option value="read-only">只读沙箱模式</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewSessionPermissionControl({ settings, onSettingChange }) {
  return (
    <div className="composer-embedded-select danger">
      <ShieldAlert size={13} />
      <span>{permissionPresetLabel(settings)}</span>
      <select
        value={`${settings.sandbox}|${settings.approvalPolicy}`}
        onChange={(event) => {
          const [sandbox, approvalPolicy] = event.target.value.split('|');
          onSettingChange('sandbox', sandbox);
          onSettingChange('approvalPolicy', approvalPolicy);
        }}
      >
        <option value="danger-full-access|never">完全访问权限</option>
        <option value="workspace-write|never">工作区写入</option>
        <option value="workspace-write|danger-only">按需授权</option>
        <option value="workspace-write|always">每次授权</option>
        <option value="read-only|always">只读模式</option>
      </select>
    </div>
  );
}

function permissionPresetLabel(settings) {
  switch (`${settings.sandbox}|${settings.approvalPolicy}`) {
    case 'danger-full-access|never': return '完全访问权限';
    case 'workspace-write|never': return '工作区写入';
    case 'workspace-write|danger-only': return '按需授权';
    case 'workspace-write|always': return '每次授权';
    case 'read-only|always': return '只读模式';
    default: return '自定义权限';
  }
}

function NewSessionComposerActions({ settings, models, modelsError, modelsLoading, sending, canSubmit, onModelChange, onServiceTierChange, onSubmit }) {
  const tierOptions = serviceTierOptions(effectiveModelForSettings(settings, models), settings.serviceTier);
  return (
    <>
      <div className="composer-embedded-select" title={modelsError ? `模型列表暂未加载：${modelsError}` : '模型'}>
        <Brain size={13} />
        <span>{modelsLoading ? '读取模型' : settings.model ? compactModelName(settings.model) : `${projectProviderLabel(settings.provider)} 默认`}</span>
        <select disabled={modelsLoading} value={settings.model} onChange={(event) => onModelChange(event.target.value)}>
          <option value="">{projectProviderLabel(settings.provider)} 默认</option>
          {models.map((model) => (
            <option key={model.id || model.model} value={model.id || model.model}>
              {compactModelName(modelLabel(model))}
            </option>
          ))}
          {settings.model && !models.some((model) => model.id === settings.model || model.model === settings.model) ? (
            <option value={settings.model}>{compactModelName(settings.model)}</option>
          ) : null}
        </select>
      </div>
      <div className="composer-embedded-select">
        <Gauge size={13} />
        <span>{serviceTierLabel(settings, models)}</span>
        <select value={settings.serviceTier || ''} onChange={(event) => onServiceTierChange(event.target.value)}>
          {tierOptions.map((tier) => (
            <option key={tier.value || 'standard'} value={tier.value}>{tier.shortLabel || tier.label}</option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="composer-circle-submit"
        disabled={sending || !canSubmit}
        onClick={onSubmit}
        title="发送并新建会话"
      >
        {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={16} strokeWidth={2.4} />}
      </button>
    </>
  );
}

function compactModelName(value) {
  return String(value || '')
    .replace(/^gpt[-\s]*/i, '')
    .replace(/^GPT[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function effectiveModelForSettings(settings, models) {
  return models.find((model) => model.id === settings.model || model.model === settings.model)
    || models.find((model) => model.isDefault)
    || models[0]
    || null;
}

function serviceTierLabel(settings, models) {
  const options = serviceTierOptions(effectiveModelForSettings(settings, models), settings.serviceTier);
  const option = options.find((item) => item.value === (settings.serviceTier || ''));
  return option?.shortLabel || option?.label || '标准';
}
