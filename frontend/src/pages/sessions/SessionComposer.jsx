import { ArrowUp, Brain, ChevronDown, Cpu, Loader2, ShieldAlert, Square } from 'lucide-react';
import PromptEditor from '../../components/editor/PromptEditor';
import {
  REASONING_EFFORT_OPTIONS,
  modelLabel,
  supportedEffortValues,
} from './sessionOptions';
import './SessionComposer.css';

const PERMISSION_PRESETS = [
  { value: 'danger-full-access|never', sandbox: 'danger-full-access', approvalPolicy: 'never', label: '完全访问权限', tone: 'danger' },
  { value: 'workspace-write|never', sandbox: 'workspace-write', approvalPolicy: 'never', label: '工作区写入', tone: 'default' },
  { value: 'workspace-write|danger-only', sandbox: 'workspace-write', approvalPolicy: 'danger-only', label: '按需授权', tone: 'default' },
  { value: 'workspace-write|always', sandbox: 'workspace-write', approvalPolicy: 'always', label: '每次授权', tone: 'default' },
  { value: 'read-only|always', sandbox: 'read-only', approvalPolicy: 'always', label: '只读模式', tone: 'default' },
];

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
  queuedMessages = [],
  onSubmit,
  onStop,
  onCancelQueuedMessage,
  onRetryQueuedMessage,
  suggestions = [],
}) {
  const selectedModel = models.find((model) => model.id === settings.model || model.model === settings.model);
  const defaultModel = models.find((model) => model.isDefault) || models[0] || null;
  const effectiveModel = selectedModel || defaultModel;
  const effortOptions = visibleEffortOptions(effectiveModel, settings.reasoningEffort);
  const hasQueuedMessages = queuedMessages.length > 0;
  const interrupting = isInterruptPending(interruptState, selectedId);
  const canSubmitMessage = Boolean(selectedId && value.trim() && !sending && !interrupting);
  const submitFromEditor = () => onSubmit({ preventDefault() {} });
  return (
    <form className="session-composer" onSubmit={onSubmit}>
      <QueueStatus
        running={running}
        queuedMessages={queuedMessages}
        onCancel={onCancelQueuedMessage}
        onRetry={onRetryQueuedMessage}
      />
      <InterruptStatus interruptState={interruptState} selectedId={selectedId} />
      <PromptEditor
        value={value}
        onChange={onChange}
        placeholder="给当前 Codex session 发送消息..."
        minHeight={84}
        variant="composer"
        footerControls={(
          <RuntimeControls
            settings={settings}
            onSettingChange={onSettingChange}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            effortOptions={effortOptions}
            effectiveModel={effectiveModel}
          />
        )}
        onSubmitKey={canSubmitMessage ? submitFromEditor : null}
        suggestions={suggestions}
        actions={(
          <ComposerActions
            sending={sending}
            running={running}
            interrupting={interrupting}
            selectedId={selectedId}
            canSend={Boolean(value.trim())}
            hasQueuedMessages={hasQueuedMessages}
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

function QueueStatus({ running, queuedMessages, onCancel, onRetry }) {
  if (!running && queuedMessages.length === 0) return null;
  return (
    <div className="session-message-queue-panel">
      {running && (
        <div className="session-message-queue-hint">
          当前 Codex 正在运行；发送会排队为下一条消息，不会引导当前响应。
        </div>
      )}
      {queuedMessages.length > 0 && (
        <ol className="session-message-queue-list" aria-label="排队消息">
          {queuedMessages.map((item, index) => (
            <li key={item.id} className={`session-message-queue-item ${item.status}`}>
              <div className="session-message-queue-main">
                <span className="session-message-queue-badge">{queueStatusLabel(item.status, index)}</span>
                <span className="session-message-queue-text">{item.prompt}</span>
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

function RuntimeControls({ settings, onSettingChange, models, modelsLoading, modelsError, effortOptions, effectiveModel }) {
  return (
    <>
      <PermissionSelect settings={settings} onSettingChange={onSettingChange} />
      <CompactSelect
        className="model"
        icon={<Cpu size={14} />}
        value={settings.model}
        displayLabel={modelDisplayLabel(settings.model, effectiveModel, models)}
        onChange={(value) => onSettingChange('model', value)}
        title={modelHint(modelsLoading, modelsError)}
      >
        <option value="">{modelPlaceholder(modelsLoading, modelsError, effectiveModel)}</option>
        {models.map((model) => <option key={model.id || model.model} value={model.id || model.model}>{compactModelName(modelLabel(model))}</option>)}
        {settings.model && !models.some((model) => model.id === settings.model || model.model === settings.model) && (
          <option value={settings.model}>{settings.model}</option>
        )}
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
    </>
  );
}

function PermissionSelect({ settings, onSettingChange }) {
  const value = permissionValue(settings);
  const preset = PERMISSION_PRESETS.find((item) => item.value === value) || PERMISSION_PRESETS[1];
  return (
    <CompactSelect
      className={`permission ${preset.tone}`}
      icon={<ShieldAlert size={14} />}
      value={preset.value}
      displayLabel={preset.label}
      onChange={(nextValue) => {
        const next = PERMISSION_PRESETS.find((item) => item.value === nextValue);
        if (!next) return;
        onSettingChange('sandbox', next.sandbox);
        onSettingChange('approvalPolicy', next.approvalPolicy);
      }}
      title="权限与授权策略"
    >
      {PERMISSION_PRESETS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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

function ComposerActions({ sending, running, interrupting, selectedId, canSend, hasQueuedMessages, onStop }) {
  if (running) {
    return (
      <>
        <button type="button" className="session-composer-circle secondary" onClick={onStop} disabled={!selectedId || interrupting} title={interrupting ? '正在中断...' : '停止'}>
          {interrupting ? <Loader2 className="animate-spin" size={14} /> : <Square size={14} fill="currentColor" />}
        </button>
        <button className="session-composer-circle" disabled={!selectedId || !canSend || sending || interrupting} title="排队为下一条消息">
          {sending ? <Loader2 className="animate-spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.4} />}
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

function isInterruptPending(interruptState, selectedId) {
  return interruptState?.sessionId === selectedId && interruptState?.status === 'pending';
}

function queueStatusLabel(status, index) {
  if (status === 'sending') return '发送中';
  if (status === 'failed') return '待重试';
  return `排队 ${index + 1}`;
}

function visibleEffortOptions(model, selectedValue) {
  const supported = supportedEffortValues(model);
  const inherited = { value: '', label: '默认推理强度', shortLabel: effortShortLabel(model?.defaultReasoningEffort) || '默认' };
  if (!supported.length) return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => option.value)];
  return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => supported.includes(option.value) || option.value === selectedValue)];
}

function modelHint(loading, error) {
  if (loading) return '正在读取真实 Codex 模型列表';
  if (error) return '模型列表暂未加载';
  return '模型';
}

function modelPlaceholder(loading, _error, model) {
  if (loading) return '读取模型';
  if (!model) return 'Codex 默认';
  return compactModelName(modelLabel(model)) || 'Codex 默认';
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

function permissionValue(settings) {
  const sandbox = settings.sandbox || 'workspace-write';
  const approvalPolicy = settings.approvalPolicy || 'never';
  return `${sandbox}|${approvalPolicy}`;
}
