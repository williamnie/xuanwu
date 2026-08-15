import { ArrowUp, Brain, Folder, Gauge, Loader2, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import PromptEditor from '../../components/editor/PromptEditor';
import SessionCommandPanel from './SessionCommandPanel';
import { clearSessionCommandState, createSessionCommandState } from './sessionCommands';
import {
  availableProviderModels,
  availableProviderModelValue,
  modelLabel,
  providerLabel as projectProviderLabel,
  serviceTierOptions,
} from './sessionOptions';
import { addSessionReference, hasComposerContent, removeSessionReference } from './sessionReferences';
import { applyExecutionPolicy, executionPolicyPresets, executionPolicyValue, isolationLabel, policyFromValue, settingsExecutionPolicy } from '../../utils/executionPolicy';

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
  providerCatalog = [],
}) {
  const selectedProviderAvailable = providerOptions.some(option => option.id === sessionSettings.provider);
  return (
    <div className="new-session-container animate-fade-in">
      <div className="new-session-center-card">
        <header className="new-session-head">
          <span className="new-session-kicker">New Provider Session</span>
          <h1 className="new-session-title">
            我们应该在 <em>{selectedProject?.name || '当前工作区'}</em> 中构建什么？
          </h1>
          <p className="new-session-subtitle">描述目标，玄武会创建 provider 会话并跟踪整个执行过程。</p>
        </header>

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
                providerCatalog={providerCatalog}
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
            <span>Provider: {selectedProviderAvailable ? projectProviderLabel(sessionSettings.provider) : '未选择'}</span>
            <select value={selectedProviderAvailable ? sessionSettings.provider : ''} onChange={(event) => handleSettingChange('provider', event.target.value)}>
              {!selectedProviderAvailable ? <option disabled value="">选择可用 Provider</option> : null}
              {providerOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>

          <div className="bottom-tag-select" title="Provider 声明的隔离能力">
            <SlidersHorizontal size={13} />
            <span>{isolationLabel(providerCatalog, sessionSettings.provider)}</span>
          </div>
        </div>

        <p className="new-session-starters-label">// 快捷开始</p>
        <div className="new-session-starters">
          {NEW_SESSION_STARTERS.map((starter) => (
            <button key={starter.title} onClick={() => setPrompt(starter.prompt)} type="button">
              <span>{starter.title}</span>
              <small>{starter.detail}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const NEW_SESSION_STARTERS = [
  { title: '修复一个 Issue', detail: '@ 引用 issue 编号，创建修复 run 并跟踪执行。', prompt: '修复 Issue #' },
  { title: '复盘最近的 Run', detail: '分析最近一次失败 run 的根因与 evidence。', prompt: '复盘最近一次失败的 run，给出根因分析与修复建议' },
  { title: '自由编码任务', detail: '直接描述需求，由 provider 在当前项目落地。', prompt: '我想实现：' },
];

function NewSessionPermissionControl({ settings, onSettingChange, providerCatalog }) {
  const policy = settingsExecutionPolicy(settings);
  const presets = executionPolicyPresets(providerCatalog, settings.provider, policy);
  const selected = presets.find(item => item.value === executionPolicyValue(policy)) || presets[0];
  return (
    <div className="composer-embedded-select danger">
      <ShieldAlert size={13} />
      <span>{selected?.label || '执行策略'}</span>
      <select
        value={selected?.value || ''}
        onChange={(event) => {
          const next = applyExecutionPolicy(settings, policyFromValue(event.target.value));
          onSettingChange('executionPolicy', next.executionPolicy);
          onSettingChange('sandbox', next.sandbox);
          onSettingChange('approvalPolicy', next.approvalPolicy);
        }}
      >
        {presets.map(option => <option disabled={option.disabled} key={option.id} value={option.value}>{option.label}{option.disabled ? '（当前 transport 不支持）' : ''}</option>)}
      </select>
    </div>
  );
}

function NewSessionComposerActions({ settings, models, modelsError, modelsLoading, sending, canSubmit, onModelChange, onServiceTierChange, onSubmit }) {
  const modelOptions = availableProviderModels(models);
  const selectedModel = availableProviderModelValue(settings.model, modelOptions);
  const tierOptions = serviceTierOptions(effectiveModelForSettings({ ...settings, model: selectedModel }, modelOptions), settings.serviceTier);
  return (
    <>
      <div className="composer-embedded-select" title={modelsError ? `模型列表暂未加载：${modelsError}` : '模型'}>
        <Brain size={13} />
        <span>{modelsLoading ? '读取模型' : selectedModel ? compactModelName(selectedModel) : `${projectProviderLabel(settings.provider)} 默认`}</span>
        <select aria-label="模型" disabled={modelsLoading} value={selectedModel} onChange={(event) => onModelChange(event.target.value)}>
          <option value="">{projectProviderLabel(settings.provider)} 默认</option>
          {modelOptions.map((model) => (
            <option key={model.id || model.model} value={model.id || model.model}>
              {compactModelName(modelLabel(model))}
            </option>
          ))}
        </select>
      </div>
      {settings.provider !== 'qoder' ? <div className="composer-embedded-select">
        <Gauge size={13} />
        <span>{serviceTierLabel(settings, models)}</span>
        <select value={settings.serviceTier || ''} onChange={(event) => onServiceTierChange(event.target.value)}>
          {tierOptions.map((tier) => (
            <option key={tier.value || 'standard'} value={tier.value}>{tier.shortLabel || tier.label}</option>
          ))}
        </select>
      </div> : null}
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
