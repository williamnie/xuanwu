import { useI18n } from '../i18n/context.js';
import { serviceTierOptions } from '../utils/serviceTier.js';
import { codeAgentLabel } from '../utils/codeAgents.js';
import { executionPolicyPresets, executionPolicyValue, policyFromValue } from '../utils/executionPolicy.js';
import './ProjectSettingsEditor.css';

export default function AgentProfileManager({ profiles, loading, form, error, modelOptions, models, modelsError, modelsLoading, onFieldChange, onSubmit, onEdit, onReset, providerCatalog, providerOptions, saving }) {
  const { language } = useI18n();
  const copy = (zh, en) => language === 'en-US' ? en : zh;
  const providerReady = providerOptions.some(option => option.value === form.provider);
  const profilePolicyOptions = executionPolicyPresets(providerCatalog, form.provider, form.execution_policy, true);
  const profilePolicyValue = form.execution_policy ? executionPolicyValue(form.execution_policy) : '';
  return (
    <div className="project-profile-manager">
      <div>
        <div className="project-profile-title">{copy('执行预设', 'Execution presets')}</div>
        <p className="project-profile-copy">{copy('给可复用的执行偏好起个名字。预设不会安装插件，也不会扩大项目权限。', 'Name a reusable execution setup. Presets do not install plugins or expand project permissions.')}</p>
      </div>
      {error && <div className="project-profile-error">{error}</div>}
      <div className="project-profile-fields">
        <div className="form-group">
          <label>{copy('预设名称', 'Preset name')}</label>
          <input className="form-control" placeholder={copy('例如：前端日常开发', 'For example: frontend development')} value={form.name} onChange={event => onFieldChange('name', event.target.value)} />
        </div>
        <div className="form-group">
          <label>{copy('默认指令（可选）', 'Default instructions (optional)')}</label>
          <textarea className="form-control" rows={3} placeholder={copy('例如：优先运行前端测试，保持最小改动', 'For example: run frontend tests and keep changes focused')} value={form.default_instructions} onChange={event => onFieldChange('default_instructions', event.target.value)} />
        </div>
        <details className="project-profile-overrides">
          <summary>{copy('更多选项', 'More options')}</summary>
          <p>{copy('只有这个预设需要覆盖项目默认值时才填写。', 'Only set values that should override project defaults.')}</p>
          <div className="form-group">
            <label>{copy('预设 ID', 'Preset ID')}</label>
            <input className="form-control" placeholder={copy('留空时根据名称自动生成', 'Leave blank to generate from the name')} value={form.id} onChange={event => onFieldChange('id', event.target.value)} />
          </div>
          <div className="project-settings-grid project-profile-grid">
            <label className="form-group">{copy('编程工具', 'Coding tool')}
              <select className="form-control" value={form.provider} onChange={event => onFieldChange('provider', event.target.value)}>
                {!providerReady && form.provider ? <option disabled value={form.provider}>{codeAgentLabel(form.provider, providerCatalog)}（不可用）</option> : null}
                {providerOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="form-group">{copy('默认模型', 'Default model')}
              {form.provider === 'qoder' || modelsError ? (
                <input className="form-control" list="profile-provider-model-suggestions" placeholder={copy('编程工具默认，或手动填写模型 ID', 'Default or custom model ID')} value={form.model} onChange={event => onFieldChange('model', event.target.value)} />
              ) : (
                <select className="form-control" disabled={modelsLoading} value={form.model} onChange={event => onFieldChange('model', event.target.value)}>
                  {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              )}
              <datalist id="profile-provider-model-suggestions">
                {modelOptions.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </datalist>
            </label>
            <label className="form-group">{copy('推理深度', 'Reasoning depth')}
              <select className="form-control" value={form.reasoning_effort} onChange={event => onFieldChange('reasoning_effort', event.target.value)}>
                {profileEffortOptions(form, models, language).map(option => <option key={option.value || 'default'} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {form.provider !== 'qoder' ? <label className="form-group">{copy('执行速度', 'Execution speed')}
              <select className="form-control" value={form.service_tier} onChange={event => onFieldChange('service_tier', event.target.value)}>
                {serviceTierOptions(form.service_tier).map(option => <option key={option.value || 'standard'} value={option.value}>{option.label}</option>)}
              </select>
            </label> : null}
            <label className="form-group">{copy('执行权限与确认', 'Permissions and confirmation')}
              <select className="form-control" value={profilePolicyValue} onChange={event => onFieldChange('execution_policy', event.target.value ? policyFromValue(event.target.value) : null)}>
                {profilePolicyOptions.map(option => <option disabled={option.disabled} key={option.id} value={option.value}>{option.label}{option.disabled ? '（当前 transport 不支持）' : ''}</option>)}
              </select>
            </label>
          </div>
          <div className="project-settings-grid project-profile-grid">
            <label className="form-group">{copy('Skill 意图（可选）', 'Skill intents (optional)')}
              <input className="form-control" placeholder={copy('多个值用逗号分隔', 'Comma-separated values')} value={form.skill_intents} onChange={event => onFieldChange('skill_intents', event.target.value)} />
            </label>
          </div>
        </details>
        <div className="project-profile-actions">
          <span>{loading ? copy('正在加载预设…', 'Loading presets…') : copy(`已有 ${profiles.length} 个预设`, `${profiles.length} presets`)}</span>
          <div><button type="button" className="btn btn-secondary" disabled={saving} onClick={onReset}>{copy('新建预设', 'New preset')}</button><button type="button" className="btn btn-secondary" disabled={saving || loading} onClick={onSubmit}>{copy('保存预设', 'Save preset')}</button></div>
        </div>
      </div>
      {profiles.length > 0 && <div className="project-profile-list">{profiles.map(profile => <button key={profile.id} type="button" className="kanban-card-action-btn" onClick={() => onEdit(profile)}>{profile.name} · {profile.id}</button>)}</div>}
    </div>
  );
}

function profileEffortOptions(form, models = [], language = 'zh-CN') {
  const english = language === 'en-US';
  const inherited = { value: '', label: english ? 'Use defaults' : '沿用默认值' };
  if (form.provider !== 'qoder') return [
    inherited,
    { value: 'low', label: english ? 'Low' : '低' },
    { value: 'medium', label: english ? 'Medium' : '中' },
    { value: 'high', label: english ? 'High' : '高' },
    { value: 'xhigh', label: english ? 'Extra high' : '极高' },
  ];
  const selected = models.find(model => (model?.id || model?.model) === form.model);
  const efforts = Array.isArray(selected?.supportedReasoningEfforts)
    ? selected.supportedReasoningEfforts.map(item => item?.reasoningEffort).filter(Boolean)
    : [];
  if (!selected?.verified || !efforts.length) {
    return form.reasoning_effort ? [inherited, { value: form.reasoning_effort, label: `${form.reasoning_effort} (${english ? 'unverified' : '未验证'})` }] : [inherited];
  }
  return [inherited, ...efforts.map(value => ({ value, label: value }))];
}
