import { Bot, Eye, KeyRound, Loader2, RefreshCw, Save } from 'lucide-react';
import { usePiAgentSettingsState } from './piAgentSettingsState';

export default function PiAgentSettingsPanel() {
  const state = usePiAgentSettingsState();

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>正在读取 Runner 配置...</div>
      ) : (
        <PiSettingsForm state={state} />
      )}
    </section>
  );
}

function PiSettingsForm({ state }) {
  return (
    <>
      <PiSettingsGrid form={state.form} updateField={state.updateField} />
      <ProviderCredentialFields state={state} />
      <AgentEnableField form={state.form} updateField={state.updateField} />
      <SaveRow onSave={state.handleSave} saving={state.saving} />
      <ProviderSummary providers={state.providers} />
    </>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={18} color="var(--primary)" /> Runner Agent Settings
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          配置 Runner 独立 provider、API path、API key 与默认模型，供全局 Runner 会话使用。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function Field({ children, label }) {
  return (
    <label className="form-group" style={{ marginBottom: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function PiSettingsGrid({ form, updateField }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
      <TextField form={form} label="Agent ID" name="agentId" updateField={updateField} />
      <TextField form={form} label="Agent Name" name="agentName" updateField={updateField} />
      <TextField form={form} label="Model Provider" name="modelProvider" placeholder="openai / anthropic / local" updateField={updateField} />
      <TextField form={form} label="Model ID" name="modelId" placeholder="gpt-5.4" updateField={updateField} />
      <ApiTypeField form={form} updateField={updateField} />
      <ThinkingField form={form} updateField={updateField} />
    </div>
  );
}

function TextField({ form, label, name, placeholder = '', updateField }) {
  return (
    <Field label={label}>
      <input className="form-control" value={form[name]} onChange={(event) => updateField(name, event.target.value)} placeholder={placeholder} />
    </Field>
  );
}

function ApiTypeField({ form, updateField }) {
  return (
    <Field label="Runner API Type">
      <select className="form-control" value={form.api} onChange={(event) => updateField('api', event.target.value)}>
        {['openai-responses', 'openai-completions', 'anthropic', 'google'].map((api) => <option key={api} value={api}>{api}</option>)}
      </select>
    </Field>
  );
}

function ThinkingField({ form, updateField }) {
  return (
    <Field label="Thinking">
      <select className="form-control" value={form.thinkingLevel} onChange={(event) => updateField('thinkingLevel', event.target.value)}>
        {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </Field>
  );
}

function ProviderCredentialFields({ state }) {
  const configured = state.selectedProvider?.api_key_configured;
  return (
    <>
      <TextField form={state.form} label="API Path / Base URL" name="baseUrl" placeholder="https://api.openai.com/v1 或自定义兼容代理地址" updateField={state.updateField} />
      <Field label={`API Key${configured ? '（已配置；留空保留旧 key）' : ''}`}>
        <input
          className="form-control"
          type="password"
          value={state.form.apiKey}
          onChange={(event) => state.updateField('apiKey', event.target.value)}
          placeholder={configured ? '已配置，输入新 key 可覆盖' : '输入 Runner provider API key'}
        />
      </Field>
      <Field label="Runner Instructions">
        <textarea className="form-control" rows={3} value={state.form.instructions} onChange={(event) => state.updateField('instructions', event.target.value)} />
      </Field>
      <PromptSummaryDebug state={state} />
    </>
  );
}

function PromptSummaryDebug({ state }) {
  const summary = state.promptSummary?.runtime_prompt_summary;
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '12px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: 'var(--text-primary)', fontSize: '0.84rem' }}>当前生效 Prompt 摘要</strong>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', margin: '3px 0 0' }}>
            只显示自定义 instructions 摘要与注入优先级；不回显 API key/token。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={state.loadPromptSummary} disabled={state.promptSummaryLoading} type="button">
          {state.promptSummaryLoading ? <Loader2 size={14} className="spin-animation" /> : <Eye size={14} />}
          查看摘要
        </button>
      </div>
      {summary && (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '8px', display: 'grid', gap: '4px' }}>
          <span>Custom instructions: {summary.custom_instructions_configured ? `${summary.custom_instructions_chars} chars` : '未配置'}</span>
          <span>注入位置：{summary.injected_after}</span>
          <span>优先级：{summary.conflict_policy}</span>
          {summary.custom_instructions_preview && <code style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{summary.custom_instructions_preview}</code>}
        </div>
      )}
    </div>
  );
}

function AgentEnableField({ form, updateField }) {
  return (
    <label style={{ display: 'flex', gap: '10px', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
      <input type="checkbox" checked={form.enabled} onChange={(event) => updateField('enabled', event.target.checked)} />
      启用这个 Runner Agent
    </label>
  );
}

function SaveRow({ onSave, saving }) {
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-primary" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 size={15} className="spin-animation" /> : <Save size={15} />}
        保存 Runner 设置
      </button>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
        API key 只写入后端 Runner models.json；读取时只显示是否 configured，不回显明文。
      </span>
    </div>
  );
}

function ProviderSummary({ providers }) {
  if (providers.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {providers.map((provider) => (
        <span key={provider.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 8px', border: '1px solid var(--border-color)', borderRadius: '999px', color: 'var(--text-muted)', fontSize: '0.76rem' }}>
          <KeyRound size={12} color={provider.api_key_configured ? 'var(--success)' : 'var(--text-muted)'} />
          {provider.id} · {provider.api} · {provider.models?.join(', ') || 'no models'}
        </span>
      ))}
    </div>
  );
}
