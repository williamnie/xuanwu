import { ArrowUp, Brain, ChevronDown, Cpu, Gauge, Loader2, ShieldAlert, Square } from 'lucide-react';
import PromptEditor from '../../components/editor/PromptEditor';
import {
  REASONING_EFFORT_OPTIONS,
  SERVICE_TIER_STANDARD,
  availableProviderModels,
  availableProviderModelValue,
  modelLabel,
  serviceTierOptions,
  supportedEffortValues,
} from './sessionOptions';
import SessionCommandPanel from './SessionCommandPanel';
import './SessionComposer.css';
import { applyExecutionPolicy, executionPolicyPresets, executionPolicyValue, policyFromValue, settingsExecutionPolicy } from '../../utils/executionPolicy.js';

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
  placeholder = "给当前 Provider session 发送消息...",
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


function InterruptStatus({ interruptState, selectedId }) {
  if (!interruptState || interruptState.sessionId !== selectedId) return null;
  return (
    <div className={`session-interrupt-status ${interruptState.tone || 'info'}`} role="status">
      {interruptState.status === 'pending' && <Loader2 className="animate-spin" size={14} />}
      <span>{interruptState.text}</span>
    </div>
  );
}

function QueueStatus({ queuedMessages, onCancel, onRetry }) {
  if (queuedMessages.length === 0) return null;
  return (
    <div className="session-message-queue-panel">
      {queuedMessages.length > 0 && (
        <ol className="session-message-queue-list" aria-label="排队消息">
          {queuedMessages.map((item, index) => (
            <li key={item.id} className={`session-message-queue-item ${item.status}`}>
              <div className="session-message-queue-main">
                <span className="session-message-queue-badge">{queueStatusLabel(item.status, index)}</span>
                <span className="session-message-queue-text">{queueMessagePreview(item)}</span>
                {item.error && <span className="session-message-queue-error">{item.error}</span>}
              </div>
              <div className="session-message-queue-actions">
                {item.status === 'failed' && (
                  <button type="button" onClick={() => onRetry?.(item.id)}>重试</button>
                )}
                <button type="button" onClick={() => onCancel?.(item.id)}>取消</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function queueMessagePreview(item) {
  const text = String(item?.prompt || '').trim();
  if (text) return text;
  const refs = Array.isArray(item?.references) ? item.references : [];
  return refs.length ? `已附加 ${refs.length} 个 references` : '';
}

function RuntimeControls({ settings, onSettingChange, models, modelsLoading, modelsError, effortOptions, tierOptions, effectiveModel, providerCatalog }) {
  const modelOptions = availableProviderModels(models);
  const selectedModel = availableProviderModelValue(settings.model, modelOptions);
  return (
    <>
      <PermissionSelect settings={settings} onSettingChange={onSettingChange} providerCatalog={providerCatalog} />
      <CompactSelect
        className="model"
        icon={<Cpu size={14} />}
        value={selectedModel}
        displayLabel={modelDisplayLabel(selectedModel, effectiveModel, modelOptions)}
        onChange={(value) => onSettingChange('model', value)}
        title={modelHint(modelsLoading, modelsError)}
      >
        <option value="">{modelPlaceholder(modelsLoading, modelsError, effectiveModel)}</option>
        {modelOptions.map((model) => <option key={model.id || model.model} value={model.id || model.model}>{compactModelName(modelLabel(model))}</option>)}
      </CompactSelect>
      <CompactSelect
        className="effort"
        icon={<Brain size={14} />}
        value={settings.reasoningEffort}
        displayLabel={effortDisplayLabel(effortOptions, settings.reasoningEffort)}
        onChange={(value) => onSettingChange('reasoningEffort', value)}
        title="推理强度"
      >
        {effortOptions.map((option) => (
          <option key={effortOptionKey(option)} value={option.value}>{option.shortLabel || option.label}</option>
        ))}
      </CompactSelect>
      {settings.provider !== 'qoder' ? <CompactSelect
        className="speed"
        icon={<Gauge size={14} />}
        value={settings.serviceTier || SERVICE_TIER_STANDARD}
        displayLabel={serviceTierDisplayLabel(tierOptions, settings.serviceTier)}
        onChange={(value) => onSettingChange('serviceTier', value)}
        title="速度"
      >
        {tierOptions.map((option) => (
          <option key={serviceTierOptionKey(option)} value={option.value}>{option.shortLabel || option.label}</option>
        ))}
      </CompactSelect> : null}
    </>
  );
}

function PermissionSelect({ settings, onSettingChange, providerCatalog }) {
  const policy = settingsExecutionPolicy(settings);
  const value = executionPolicyValue(policy);
  const presets = executionPolicyPresets(providerCatalog, settings.provider, policy);
  const preset = presets.find((item) => item.value === value) || presets[0];
  return (
    <CompactSelect
      className={`permission ${preset.tone}`}
      icon={<ShieldAlert size={14} />}
      value={preset.value}
      displayLabel={preset.label}
      onChange={(nextValue) => {
        const next = applyExecutionPolicy(settings, policyFromValue(nextValue));
        onSettingChange('executionPolicy', next.executionPolicy);
        onSettingChange('sandbox', next.sandbox);
        onSettingChange('approvalPolicy', next.approvalPolicy);
      }}
      title="权限与授权策略"
    >
      {presets.map((option) => (
        <option
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.label}{option.disabled ? '（当前 transport 不支持）' : ''}
        </option>
      ))}
    </CompactSelect>
  );
}

function CompactSelect({ className, icon, value, displayLabel, onChange, title, children }) {
  return (
    <label className={`session-composer-select ${className}`} title={title}>
      {icon}
      <span className="session-composer-select-value">{displayLabel}</span>
      <select aria-label={title} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={13} className="session-composer-chevron" />
    </label>
  );
}

function ComposerActions({
  sending,
  running,
  interrupting,
  selectedId,
  canSend,
  hasQueuedMessages,
  followMode,
  onFollowModeChange,
  onStop,
}) {
  const modeSwitch = running && onFollowModeChange && canSend ? (
    <ComposerModeSwitch value={followMode} onChange={onFollowModeChange} disabled={sending || interrupting} />
  ) : null;
  if (running) {
    return (
      <>
        {modeSwitch}
        <button type="button" className="session-composer-circle stop" onClick={onStop} disabled={!selectedId || interrupting} title={interrupting ? '正在中断...' : '停止'}>
          {interrupting ? <Loader2 className="animate-spin" size={14} /> : <Square size={14} fill="currentColor" />}
        </button>
      </>
    );
  }
  return (
    <button className="session-composer-circle" disabled={!selectedId || !canSend || sending || interrupting} title={hasQueuedMessages ? '追加到队列' : '发送'}>
      {sending ? <Loader2 className="animate-spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.4} />}
    </button>
  );
}

function ComposerModeSwitch({ value, onChange, disabled }) {
  return (
    <div className="session-composer-mode-switch" role="group" aria-label="运行中发送行为">
      <button
        type="button"
        className={!value ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange?.(false)}
      >
        排队
      </button>
      <button
        type="button"
        className={value ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange?.(true)}
      >
        引导
      </button>
    </div>
  );
}

function isInterruptPending(interruptState, selectedId) {
  return interruptState?.sessionId === selectedId && interruptState?.status === 'pending';
}

function queueStatusLabel(status, index) {
  if (status === 'sending') return '发送中';
  if (status === 'failed') return '待重试';
  return `排队 ${index + 1}`;
}

function visibleEffortOptions(model, selectedValue, provider) {
  const supported = supportedEffortValues(model);
  const inherited = { value: '', label: '默认推理强度', shortLabel: effortShortLabel(model?.defaultReasoningEffort) || '默认' };
  if (provider === 'qoder') {
    if (model?.verified !== true || !supported.length) {
      return selectedValue
        ? [inherited, { value: selectedValue, label: `${selectedValue}（未验证）`, shortLabel: selectedValue }]
        : [inherited];
    }
    const qoderOptions = supported.map((value) => {
      const known = REASONING_EFFORT_OPTIONS.find((option) => option.value === value);
      return known || { value, label: value, shortLabel: value };
    });
    if (selectedValue && !supported.includes(selectedValue)) {
      qoderOptions.push({ value: selectedValue, label: `${selectedValue}（当前模型不支持）`, shortLabel: selectedValue });
    }
    return [inherited, ...qoderOptions];
  }
  if (!supported.length) return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => option.value)];
  return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => supported.includes(option.value) || option.value === selectedValue)];
}

function modelHint(loading, error) {
  if (loading) return '正在读取 Provider 模型列表';
  if (error) return `模型列表暂未加载：${error}`;
  return '模型';
}

function modelPlaceholder(loading, _error, model) {
  if (loading) return '读取模型';
  if (!model) return 'Provider 默认';
  return compactModelName(modelLabel(model)) || 'Provider 默认';
}

function modelDisplayLabel(value, effectiveModel, models) {
  const selected = models.find((model) => model.id === value || model.model === value);
  if (selected) return compactModelName(modelLabel(selected));
  if (value) return compactModelName(value);
  return modelPlaceholder(false, '', effectiveModel);
}

function effortOptionKey(option) {
  return `${option.value || 'inherit'}:${option.label || ''}:${option.shortLabel || ''}`;
}

function effortDisplayLabel(options, value) {
  const option = options.find((item) => item.value === value);
  return option?.shortLabel || option?.label || '默认';
}

function serviceTierOptionKey(option) {
  return `${option.value || 'standard'}:${option.label || ''}`;
}

function serviceTierDisplayLabel(options, value) {
  const option = options.find((item) => item.value === (value || SERVICE_TIER_STANDARD));
  return option?.shortLabel || option?.label || '标准';
}

function compactModelName(value) {
  return String(value || '')
    .replace(/^gpt[-\s]*/i, '')
    .replace(/^GPT[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function effortShortLabel(value) {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.shortLabel || '';
}
