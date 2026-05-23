import { Loader2, Plus, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import PromptEditor from '../../components/editor/PromptEditor';
import {
  APPROVAL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  SANDBOX_OPTIONS,
  providerLabel,
  modelLabel,
  supportedEffortValues,
} from './sessionOptions';
import './SessionCreateModal.css';

export default function SessionCreateModal({
  projects,
  projectId,
  cwd,
  prompt,
  sending,
  selectedProject,
  models,
  modelsLoading,
  modelsError,
  settings,
  onProjectChange,
  onCwdChange,
  onPromptChange,
  onSettingsChange,
  onClose,
  onSubmit,
}) {
  const selectedModel = models.find((model) => model.id === settings.model || model.model === settings.model);
  const effortOptions = visibleEffortOptions(selectedModel, settings.reasoningEffort);
  return (
    <div className="modal-overlay">
      <form className="session-create-modal" onSubmit={onSubmit}>
        <CreateHeader />
        <ProjectFields
          projects={projects}
          projectId={projectId}
          cwd={cwd}
          selectedProject={selectedProject}
          onProjectChange={onProjectChange}
          onCwdChange={onCwdChange}
        />
        <RuntimeFields
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          settings={settings}
          effortOptions={effortOptions}
          onSettingsChange={onSettingsChange}
        />
        <PromptField prompt={prompt} onPromptChange={onPromptChange} />
        <ModalActions sending={sending} onClose={onClose} />
      </form>
    </div>
  );
}

function CreateHeader() {
  return (
    <header className="session-create-header">
      <div className="session-create-icon"><SlidersHorizontal size={18} /></div>
      <div>
        <h3>创建 Codex Session</h3>
        <p>选择真实 Codex 运行参数，配置会随 thread/turn 一起提交。</p>
      </div>
    </header>
  );
}

function ProjectFields({ projects, projectId, cwd, selectedProject, onProjectChange, onCwdChange }) {
  return (
    <section className="session-create-section">
      <label>项目配置</label>
      <select className="form-control" value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
        <option value="">手动输入 CWD</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <input className="form-control" value={cwd} onChange={(e) => onCwdChange(e.target.value)} placeholder="/absolute/project/path" />
      {selectedProject && (
        <small>
          Provider: {providerLabel(selectedProject.provider)}；默认带入项目配置，可在下方对本次 session 覆盖。
        </small>
      )}
    </section>
  );
}

function RuntimeFields({ models, modelsLoading, modelsError, settings, effortOptions, onSettingsChange }) {
  return (
    <section className="session-create-runtime">
      <SelectField label="模型" value={settings.model} onChange={(value) => onSettingsChange('model', value)}>
        <option value="">Codex 默认模型</option>
        {models.map((model) => (
          <option key={model.id || model.model} value={model.id || model.model}>{modelLabel(model)}</option>
        ))}
        {settings.model && !models.some((model) => model.id === settings.model || model.model === settings.model) && (
          <option value={settings.model}>{settings.model}</option>
        )}
      </SelectField>
      <SelectField label="推理强度" value={settings.reasoningEffort} onChange={(value) => onSettingsChange('reasoningEffort', value)}>
        {effortOptions.map((option) => <option key={option.value || 'default'} value={option.value}>{option.label}</option>)}
      </SelectField>
      <SelectField label="审批策略" value={settings.approvalPolicy} onChange={(value) => onSettingsChange('approvalPolicy', value)}>
        {APPROVAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </SelectField>
      <SelectField label="沙箱" value={settings.sandbox} onChange={(value) => onSettingsChange('sandbox', value)}>
        {SANDBOX_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </SelectField>
      <RuntimeHint modelsLoading={modelsLoading} modelsError={modelsError} />
    </section>
  );
}

function SelectField({ label, value, onChange, children }) {
  return (
    <label className="session-create-select">
      <span>{label}</span>
      <select className="form-control" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function RuntimeHint({ modelsLoading, modelsError }) {
  if (modelsLoading) return <div className="session-create-hint"><Loader2 className="animate-spin" size={13} /> 正在读取 Codex 模型列表</div>;
  if (modelsError) return <div className="session-create-hint error">{modelsError}</div>;
  return <div className="session-create-hint"><ShieldCheck size={13} /> 授权请求会在运行中弹出确认框，不再自动拒绝。</div>;
}

function PromptField({ prompt, onPromptChange }) {
  return (
    <section className="session-create-section">
      <label>首条消息（可选）</label>
      <PromptEditor value={prompt} onChange={onPromptChange} placeholder="创建后立即发送给 Codex..." minHeight={130} variant="composer" />
    </section>
  );
}

function ModalActions({ sending, onClose }) {
  return (
    <div className="session-create-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
      <button className="btn btn-primary" disabled={sending}>
        {sending ? <Loader2 className="animate-spin" size={15} /> : <Plus size={15} />} 创建
      </button>
    </div>
  );
}

function visibleEffortOptions(model, selectedValue) {
  const supported = supportedEffortValues(model);
  if (!supported.length) return REASONING_EFFORT_OPTIONS;
  return REASONING_EFFORT_OPTIONS.filter((option) => !option.value || supported.includes(option.value) || option.value === selectedValue);
}
