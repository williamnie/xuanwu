import { credentialReady } from './piCredentialSource.js';
import { Loader2, Save } from 'lucide-react';
import { connectionApiLabel } from './piProviderConnectionLabels.js';
import { Field, TextField } from './PiSettingsFields.jsx';

export function SupervisorBehaviorSettings({ state }) {
  return (
    <>
      <AppliedModelSummary state={state} />
      <SupervisorSettingsGrid state={state} />
      <details className="persona-settings-disclosure supervisor-more-options">
        <summary><span><strong>更多选项</strong><small>给玄武的长期说明</small></span></summary>
        <Field label="给玄武的长期说明">
          <textarea className="form-control" rows={4} value={state.form.instructions} onChange={(event) => state.updateField('instructions', event.target.value)} />
        </Field>
      </details>
      <SupervisorEnableField form={state.form} updateField={state.updateField} />
      <SaveRow onSave={state.handleAgentSave} saving={state.saving} disabled={state.form.api === 'openai-codex-responses' && !credentialReady(state.form, state.oauthStatus)} />
    </>
  );
}

function AppliedModelSummary({ state }) {
  return (
    <div className="supervisor-applied-model">
      <span><small>当前默认模型</small><strong>{connectionApiLabel(state.form.api)} · {state.form.modelId}</strong></span>
      <em>在上方连接区修改</em>
    </div>
  );
}

function SupervisorSettingsGrid({ state }) {
  return (
    <div className="supervisor-behavior-grid">
      <TextField form={state.form} label="助手名称" name="agentName" updateField={state.updateField} />
      <ThinkingField form={state.form} updateField={state.updateField} />
    </div>
  );
}

function ThinkingField({ form, updateField }) {
  return (
    <Field label="思考强度">
      <select className="form-control" value={form.thinkingLevel} onChange={(event) => updateField('thinkingLevel', event.target.value)}>
        {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </Field>
  );
}

function SupervisorEnableField({ form, updateField }) {
  return <label className="supervisor-enable-field"><input type="checkbox" checked={form.enabled} onChange={(event) => updateField('enabled', event.target.checked)} /> 启用玄武助手</label>;
}

function SaveRow({ onSave, saving, disabled }) {
  return (
    <div className="supervisor-save-row">
      <button className="btn btn-secondary" onClick={onSave} disabled={saving || disabled} type="button">{saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存运行偏好</button>
      <span>保存名称、思考强度与长期说明，不会改写上方连接凭据；表达风格在“通用”中单独保存。</span>
    </div>
  );
}
