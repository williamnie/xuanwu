import { Bot, CheckCircle2, CircleDashed, Eye, KeyRound, Loader2, PlugZap, RefreshCw, Save, ShieldCheck, SlidersHorizontal, Sparkles, XCircle } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';
import { usePiAgentSettingsState } from './piAgentSettingsState';

export default function PiAgentSettingsPanel({ view = 'agent' }) {
  const state = usePiAgentSettingsState();

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} view={view} />
      {state.loading ? (
        <PanelLoader label="玄武正在读取 Supervisor 配置…" />
      ) : (
        <PiSettingsForm state={state} view={view} />
      )}
    </section>
  );
}

function PiSettingsForm({ state, view }) {
  if (view === 'connection') return <ProviderConnectionSettings state={state} />;
  if (view === 'agent') return <AgentBehaviorSettings state={state} />;
  return <AgentBehaviorSettings state={state} />;
}

function AgentBehaviorSettings({ state }) {
  return (
    <>
      <div className="provider-advanced-heading">
        <Bot size={17} />
        <div>
          <strong>Supervisor behavior</strong>
          <span>选择已经配置的 provider/model，并维护名称、thinking 与运行指令；连接凭据统一在 Connections 管理。</span>
        </div>
      </div>
      <AgentSettingsGrid state={state} />
      <Field label="Runtime Instructions">
        <textarea className="form-control" rows={4} value={state.form.instructions} onChange={(event) => state.updateField('instructions', event.target.value)} />
      </Field>
      <PromptSummaryDebug state={state} />
      <AgentEnableField form={state.form} updateField={state.updateField} />
      <SaveRow mode="agent" onSave={state.handleAgentSave} saving={state.saving} />
    </>
  );
}

function ProviderConnectionSettings({ state }) {
  return (
    <>
      <ProviderPresetCards state={state} />
      {state.selectedPreset ? (
        <RecommendedProviderConfiguration state={state} />
      ) : (
        <div className="provider-custom-notice">
          <SlidersHorizontal size={18} />
          <div>
            <strong>当前使用自定义 provider：{state.form.modelProvider || '未命名'}</strong>
            <span>展开下方“自定义 / 高级 Provider”即可维护底层连接参数。</span>
          </div>
        </div>
      )}
      <AdvancedProviderDisclosure state={state} />
      <SaveRow mode="connection" onSave={state.handleConnectionSave} saving={state.saving} />
      <ProviderSummary providers={state.providers} />
    </>
  );
}

function AdvancedProviderDisclosure({ state }) {
  return (
    <details className="provider-advanced-disclosure" defaultOpen={!state.selectedPreset}>
      <summary>
        <SlidersHorizontal size={17} />
        <span>
          <strong>自定义 / 高级 Provider</strong>
          <small>仅在接入自定义网关、代理或兼容 API 时使用</small>
        </span>
      </summary>
      <div className="provider-advanced-content">
        <AdvancedProviderGrid state={state} />
        <ProviderCredentialFields state={state} />
        {state.form.api === 'openai-codex-responses' && <CodexOAuthPanel state={state} />}
        <div className="provider-recommended-actions">
          <ConnectionTestAction state={state} />
        </div>
        <ConnectionResult state={state} />
      </div>
    </details>
  );
}

function ProviderPresetCards({ state }) {
  return (
    <div className="provider-preset-grid" aria-label="推荐 provider">
      {state.providerCatalog.presets.map((preset) => {
        const selected = preset.id === state.form.modelProvider;
        const status = providerCardStatus(state, preset);
        return (
          <button
            aria-pressed={selected}
            className={`provider-preset-card ${selected ? 'selected' : ''}`}
            key={preset.id}
            onClick={() => state.selectProviderPreset(preset)}
            type="button"
          >
            <div className="provider-preset-card-topline">
              <span className="provider-preset-mark">{preset.label.slice(0, 1)}</span>
              {preset.recommended && <span className="provider-recommended-badge"><Sparkles size={11} /> 推荐</span>}
            </div>
            <div>
              <strong>{preset.label}</strong>
              <p>{preset.description}</p>
            </div>
            <span className={`provider-connection-chip ${status.tone}`}>
              <status.Icon size={13} /> {status.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RecommendedProviderConfiguration({ state }) {
  const preset = state.selectedPreset;
  const configured = preset.auth === 'oauth'
    ? state.oauthStatus?.pi_oauth?.configured
    : state.selectedProvider?.api_key_configured;
  return (
    <div className="provider-recommended-config">
      <div className="provider-config-heading">
        <div>
          <span className="settings-entry-eyebrow">Selected connection</span>
          <h3>{preset.label}</h3>
          <p>{configured ? '凭据已安全配置；更新时不会回显旧密钥。' : preset.auth === 'oauth' ? '使用 OAuth 完成连接。' : '输入 API key 后可先测试连接再保存。'}</p>
        </div>
        <span className="provider-default-model"><ShieldCheck size={14} /> 推荐 {preset.recommended_model}</span>
      </div>
      {preset.auth === 'oauth' ? <CodexOAuthPanel state={state} /> : <RecommendedApiKeyField state={state} />}
      <div className="provider-recommended-actions">
        <RecommendedModelField state={state} />
        <ConnectionTestAction state={state} />
      </div>
      <ConnectionResult state={state} />
    </div>
  );
}

function RecommendedApiKeyField({ state }) {
  const configured = state.selectedProvider?.api_key_configured;
  return (
    <Field label={`API Key${configured ? '（已配置；留空保留）' : ''}`}>
      <input
        autoComplete="new-password"
        className="form-control"
        onChange={(event) => state.updateField('apiKey', event.target.value)}
        placeholder={configured ? '••••••••  输入新 key 可覆盖' : '粘贴 API key'}
        type="password"
        value={state.form.apiKey}
      />
    </Field>
  );
}

function RecommendedModelField({ state }) {
  return <RemoteModelField label="Connection model" state={state} />;
}

function ConnectionTestAction({ state }) {
  const busy = state.connectionTest.busy && state.connectionTest.providerId === state.form.modelProvider;
  return (
    <button className="btn btn-secondary provider-test-button" disabled={busy} onClick={state.testConnection} type="button">
      {busy ? <Loader2 size={15} className="spin-animation" /> : <PlugZap size={15} />}
      测试连接并发现模型
    </button>
  );
}

function ConnectionResult({ state }) {
  const test = state.connectionTest;
  if (test.providerId !== state.form.modelProvider || !test.result) return null;
  return (
    <div className={`provider-test-result ${test.result.ok ? 'success' : 'error'}`} role="status">
      {test.result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
      <span>{test.result.message || (test.result.ok ? '连接成功' : '连接失败')}</span>
    </div>
  );
}

function providerCardStatus(state, preset) {
  const test = state.connectionTest.providerId === preset.id ? state.connectionTest.result : null;
  if (test?.ok) return { Icon: CheckCircle2, label: '连接成功', tone: 'success' };
  if (test && !test.ok) return { Icon: XCircle, label: '连接失败', tone: 'error' };
  const configured = preset.auth === 'oauth'
    ? state.oauthStatus?.pi_oauth?.configured
    : state.providers.find((provider) => provider.id === preset.id)?.api_key_configured;
  if (configured) return { Icon: ShieldCheck, label: '已配置', tone: 'configured' };
  return { Icon: CircleDashed, label: '未连接', tone: 'idle' };
}

function PanelHeader({ loading, onRefresh, view }) {
  const copy = panelHeaderCopy(view);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={18} color="var(--primary)" /> {copy.title}
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          {copy.description}
        </p>
      </div>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function panelHeaderCopy(view) {
  if (view === 'connection') {
    return {
      title: 'AI Providers',
      description: '配置 OpenAI、Codex、Anthropic 或兼容 provider 的凭据、可用模型与连接测试。',
    };
  }
  return {
    title: 'PI Agent',
    description: '配置唯一 Supervisor 的模型选择、thinking 与运行指令；provider 凭据和连接测试统一在 Connections 管理。',
  };
}

function Field({ children, label }) {
  return (
    <label className="form-group" style={{ marginBottom: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function AdvancedProviderGrid({ state }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
      <TextField form={state.form} label="Model Provider" name="modelProvider" placeholder="openai / anthropic / local" updateField={state.updateField} />
      <RemoteModelField label="Available Model" state={state} />
      <ApiTypeField form={state.form} updateField={state.updateField} />
    </div>
  );
}

function AgentSettingsGrid({ state }) {
  const providerOptions = [...new Set([
    state.form.modelProvider,
    ...state.providers.map((provider) => provider.id),
    ...state.providerCatalog.presets.map((preset) => preset.id),
  ].filter(Boolean))];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
      <TextField form={state.form} label="Supervisor Display Name" name="agentName" updateField={state.updateField} />
      <Field label="Model Provider">
        <select className="form-control" value={state.form.modelProvider} onChange={(event) => state.selectModelProvider(event.target.value)}>
          {providerOptions.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
      </Field>
      <RemoteModelField label="Model ID" state={state} />
      <ThinkingField form={state.form} updateField={state.updateField} />
    </div>
  );
}

function RemoteModelField({ label, state }) {
  const discovery = state.modelDiscovery.providerId === state.form.modelProvider ? state.modelDiscovery : null;
  const failed = discovery?.result && !discovery.result.ok;
  return (
    <Field label={label}>
      {failed ? (
        <>
          <input
            className="form-control"
            value={state.form.modelId}
            onChange={(event) => state.updateField('modelId', event.target.value)}
            placeholder="模型 API 失败，请手动填写 model ID"
          />
          <span style={{ color: 'var(--warning)', fontSize: '0.72rem', marginTop: '4px' }}>
            远端模型列表不可用，已启用手填：{discovery.result.message || 'model API error'}
          </span>
        </>
      ) : (
        <>
          <select
            className="form-control"
            disabled={!state.modelSelectAvailable || discovery?.busy}
            value={state.form.modelId}
            onChange={(event) => state.updateField('modelId', event.target.value)}
          >
            {state.modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          {discovery?.busy && <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '4px' }}>正在从远端 model API 读取模型…</span>}
        </>
      )}
    </Field>
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
    <Field label="Runtime API Type">
      <select className="form-control" value={form.api} onChange={(event) => updateField('api', event.target.value)}>
        {['openai-responses', 'openai-codex-responses', 'openai-completions', 'anthropic', 'google'].map((api) => <option key={api} value={api}>{api}</option>)}
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
      <TextField form={state.form} label="User-Agent" name="userAgent" placeholder="例如 XuanwuSupervisor/1.0" updateField={state.updateField} />
      <Field label={`API Key${configured ? '（已配置；留空保留旧 key）' : ''}`}>
        <input
          className="form-control"
          type="password"
          value={state.form.apiKey}
          onChange={(event) => state.updateField('apiKey', event.target.value)}
          placeholder={configured ? '已配置，输入新 key 可覆盖' : '输入 Supervisor provider API key'}
        />
      </Field>
    </>
  );
}

function CodexOAuthPanel({ state }) {
  const status = state.oauthStatus;
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '12px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)', display: 'grid', gap: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: 'var(--text-primary)', fontSize: '0.84rem' }}>Codex OAuth</strong>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', margin: '3px 0 0' }}>
            点击后只生成登录地址；你可以复制到已登录 ChatGPT 的浏览器打开。Runner 不读取或导入 Codex token。
          </p>
        </div>
        <OAuthButtons state={state} />
      </div>
      <OAuthStatusLine status={status} />
    </div>
  );
}

function OAuthButtons({ state }) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" onClick={state.loadOAuthStatus} disabled={state.oauthBusy} type="button">
        {state.oauthBusy ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} 刷新 OAuth
      </button>
      <button className="btn btn-secondary" onClick={state.startPiCodexOAuthLogin} disabled={state.oauthBusy} type="button">
        <KeyRound size={14} /> 生成登录地址
      </button>
      <button className="btn btn-secondary" onClick={state.copyPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">
        复制登录地址
      </button>
      <button className="btn btn-secondary" onClick={state.openPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">
        在默认浏览器打开
      </button>
      <button className="btn btn-secondary" onClick={state.logoutPiCodexOAuth} disabled={state.oauthBusy || !state.oauthStatus?.pi_oauth?.configured} type="button">
        退出 Supervisor OAuth
      </button>
    </div>
  );
}

function OAuthStatusLine({ status }) {
  return (
    <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', display: 'grid', gap: '4px' }}>
      <span>Supervisor OAuth：{status?.pi_oauth?.configured ? '已配置' : '未配置'} · {status?.pi_oauth?.status || 'idle'}</span>
      <span>本机 Codex 登录：{status?.codex_login?.configured ? '已检测到' : '未检测到'} · {status?.codex_login?.storage || 'file'}</span>
      {status?.auth_url && <code style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{status.auth_url}</code>}
    </div>
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
      启用 Supervisor
    </label>
  );
}

function SaveRow({ mode, onSave, saving }) {
  const connection = mode === 'connection';
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-primary" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 size={15} className="spin-animation" /> : <Save size={15} />}
        {connection ? '保存 Provider 连接' : '保存 Supervisor 行为'}
      </button>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
        {connection
          ? '凭据和可用模型只写入现有 provider authority；不会改变 Supervisor 默认选择。'
          : '更新 Supervisor 行为与默认模型；远端新模型会登记到现有 provider，但不会改写凭据。'}
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
