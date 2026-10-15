import { CheckCircle2, CircleDashed, KeyRound, Loader2, PlugZap, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { piConnectionStatus } from './piConnectionStatus.js';
import { PanelLoader } from '../components/TurtleLoader';
import { usePiAgentSettingsState } from './piAgentSettingsState';
import './PiAgentSettingsPanel.css';

export default function PiAgentSettingsPanel() {
  const state = usePiAgentSettingsState();
  return (
    <section className="supervisor-settings-panel">
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.loading ? <PanelLoader label="正在读取玄武助手配置…" /> : <SupervisorSettingsForm state={state} />}
    </section>
  );
}

function SupervisorSettingsForm({ state }) {
  return (
    <>
      <SupervisorReadiness state={state} />
      <ConfigurationStage
        description="填写模型服务提供的 API 地址和 Key，或使用账号快捷登录。获取并选择模型后，保存为默认模型。"
        index="01"
        title="连接助手模型"
      >
        <ProviderConnectionSettings state={state} />
      </ConfigurationStage>
      <ConfigurationStage
        description="设置玄武的名称、思考强度、工作指令，以及对话和通知的表达方式。"
        index="02"
        title="助手偏好"
      >
        <SupervisorBehaviorSettings state={state} />
      </ConfigurationStage>
    </>
  );
}

function SupervisorReadiness({ state }) {
  const connectionSaved = Boolean(state.selectedProvider);
  const modelSelected = Boolean(state.form.modelId.trim());
  return (
    <div className="supervisor-readiness" aria-label="Xuanwu assistant readiness">
      <ReadinessItem label="Connection" ready={connectionSaved} value={connectionSaved ? connectionApiLabel(state.form.api) : '待配置'} />
      <ReadinessItem label="Model" ready={modelSelected} value={modelSelected ? state.form.modelId : '待选择'} />
      <ReadinessItem label="玄武助手" ready={state.form.enabled} value={state.form.enabled ? '已启用' : '已停用'} />
    </div>
  );
}

function ReadinessItem({ label, ready, value }) {
  return (
    <div className={`supervisor-readiness-item ${ready ? 'ready' : ''}`}>
      {ready ? <CheckCircle2 size={13} /> : <CircleDashed size={13} />}
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function ConfigurationStage({ children, description, index, title }) {
  return (
    <section className="settings-configuration-stage supervisor-configuration-stage">
      <header className="settings-stage-header">
        <span>{index}</span>
        <div><h3>{title}</h3><p>{description}</p></div>
      </header>
      <div className="settings-stage-content">{children}</div>
    </section>
  );
}

function ProviderConnectionSettings({ state }) {
  const oauthMode = state.form.api === 'openai-codex-responses';
  return (
    <div className="provider-console">
      <div className="provider-console-main">
        <SavedConnectionPicker key={state.selectedProvider?.id || 'new-connection'} state={state} />
        <ConnectionModeTabs oauthMode={oauthMode} state={state} />
        {oauthMode ? <OAuthConnectionFlow state={state} /> : <ApiConnectionFlow state={state} />}
        <ModelSelection state={state} />
        <ConnectionResult state={state} />
        <ConnectionActions state={state} />
        <ProviderSummary providers={state.providers} />
      </div>
      <ConnectionProgress oauthMode={oauthMode} state={state} />
    </div>
  );
}

function SavedConnectionPicker({ state }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const provider = state.selectedProvider;
  const deleting = state.deletingProviderId === provider?.id;
  return (
    <div className="provider-connection-picker-block">
      <div className="provider-connection-toolbar">
        <span className="provider-console-label">CONNECTION</span>
        <div className="provider-connection-picker">
          <label>
            <span>已有连接</span>
            <select
              aria-label="已有连接"
              className="form-control"
              onChange={(event) => event.target.value ? state.selectModelProvider(event.target.value) : state.startNewApiConnection()}
              value={provider?.id || ''}
            >
              <option value="">＋ 新建连接</option>
              {state.providers.map((item) => <option key={item.id} value={item.id}>{connectionDisplayName(item)}</option>)}
            </select>
          </label>
          {provider ? (
            <button
              className="btn btn-secondary provider-delete-trigger"
              disabled={provider.in_use || deleting}
              onClick={() => setConfirmingDelete(true)}
              title={provider.in_use ? '当前默认连接不能删除，请先切换并保存其他连接' : '删除此模型连接'}
              type="button"
            >
              <Trash2 size={13} /> {provider.in_use ? '默认连接' : '删除连接'}
            </button>
          ) : null}
        </div>
      </div>
      {confirmingDelete && provider ? (
        <div aria-labelledby="provider-delete-confirm-title" className="provider-delete-confirm" role="alertdialog">
          <div>
            <strong id="provider-delete-confirm-title">删除 {connectionDisplayName(provider)}？</strong>
            <span>{provider.id === 'openai-codex' ? '将同时移除玄武助手的 OAuth 授权。' : '将同时撤销为此连接保存的 API Key。'}</span>
          </div>
          <div>
            <button className="btn btn-secondary" disabled={deleting} onClick={() => setConfirmingDelete(false)} type="button">取消</button>
            <button
              className="btn provider-delete-confirm-button"
              disabled={deleting}
              onClick={async () => {
                if (await state.deleteProviderConnection(provider.id)) setConfirmingDelete(false);
              }}
              type="button"
            >
              <Trash2 size={13} /> {deleting ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionModeTabs({ oauthMode, state }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  return (
    <fieldset className="settings-notification-modes provider-mode-tabs">
      <legend>{english ? 'Connection method' : '连接方式'}</legend>
      <div className="settings-notification-mode">
        <label>
          <input checked={!oauthMode} name="assistant-connection-mode" onChange={state.selectApiMode} type="radio" />
          <span><strong>{english ? 'API connection' : 'API 连接'}</strong><small>{english ? 'Enter the API URL and key.' : '填写 API 地址和 Key。'}</small></span>
        </label>
      </div>
      <div className="settings-notification-mode">
        <label>
          <input checked={oauthMode} name="assistant-connection-mode" onChange={state.selectOAuthMode} type="radio" />
          <span><strong>{english ? 'Sign in with Codex / ChatGPT' : '用 Codex / ChatGPT 账号登录'}</strong><small>{english ? 'Authorize the assistant with your account.' : '使用账号为玄武助手授权。'}</small></span>
        </label>
      </div>
    </fieldset>
  );
}

function ApiConnectionFlow({ state }) {
  const configured = state.selectedProvider?.api_key_configured;
  return (
    <section className="provider-flow-section">
      <FlowHeading badge="推荐从这里开始" description="不要求安装 Codex 或 Claude Code，只要有兼容的 API 地址和 Key 即可。" title="连接到一个模型 API" />
      <div className="provider-credential-grid">
        <ApiTypeField state={state} />
        <TextField form={state.form} hint="Base URL / API Path" label="API 地址" name="baseUrl" placeholder="https://api.openai.com/v1" updateField={state.updateField} />
        <ApiKeyField configured={configured} state={state} />
      </div>
    </section>
  );
}

function ApiKeyField({ configured, state }) {
  const [visible, setVisible] = useState(false);
  return (
    <Field className="provider-api-key-field" hint="只写入，不回显已保存值" label={`API Key${configured ? ' · 已配置' : ''}`}>
      <div className="provider-key-control">
        <input
          autoComplete="new-password"
          className="form-control"
          onChange={(event) => state.updateField('apiKey', event.target.value)}
          placeholder={configured ? '••••••••  留空保留，输入新 Key 可覆盖' : '粘贴 API Key'}
          type={visible ? 'text' : 'password'}
          value={state.form.apiKey}
        />
        <button onClick={() => setVisible((current) => !current)} type="button">{visible ? '隐藏' : '显示'}</button>
      </div>
    </Field>
  );
}

function OAuthConnectionFlow({ state }) {
  return (
    <section className="provider-flow-section">
      <FlowHeading badge="可选捷径" description="OAuth 只替代 API 地址和 Key；登录后仍要获取并选择模型。" title="用现有账号快捷登录" />
      <CodexOAuthPanel state={state} />
      <p className="supervisor-oauth-note">助手快捷登录目前支持 Codex / ChatGPT。Claude Code 的本机登录请前往“编程工具”检查。</p>
    </section>
  );
}

function FlowHeading({ badge, description, title }) {
  return (
    <div className="provider-flow-heading">
      <div><h4>{title}</h4><p>{description}</p></div>
      <span>{badge}</span>
    </div>
  );
}

function ModelSelection({ state }) {
  const discovery = state.modelDiscovery.providerId === state.form.modelProvider ? state.modelDiscovery : null;
  return (
    <section className="provider-model-section">
      <div className="provider-model-heading">
        <div><strong>获取并选择模型</strong><span>{modelDiscoveryHelp(discovery)}</span></div>
        <button className="btn btn-secondary" disabled={discovery?.busy} onClick={state.discoverModels} type="button">
          {discovery?.busy ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} 获取模型
        </button>
      </div>
      <RemoteModelField key={state.form.modelProvider} state={state} />
    </section>
  );
}

function modelDiscoveryHelp(discovery) {
  if (discovery?.busy) return '正在读取远端模型列表…';
  if (discovery?.result?.ok) return `已读取 ${discovery.result.models?.length || 0} 个模型，选择一个作为默认模型。`;
  if (discovery?.result && !discovery.result.ok) return discovery.result.message || '远端模型列表不可用，可手动填写模型 ID。';
  return '先验证凭据，再从远端读取模型列表。';
}

function RemoteModelField({ state }) {
  const [manual, setManual] = useState(false);
  const discovery = state.modelDiscovery.providerId === state.form.modelProvider ? state.modelDiscovery : null;
  const failed = Boolean(discovery?.result && !discovery.result.ok);
  const manualMode = manual || failed;

  return (
    <div className="provider-model-row">
      {manualMode ? (
        <input aria-label="模型 ID" className="form-control" onChange={(event) => state.updateField('modelId', event.target.value)} placeholder="例如 gpt-5.4 / claude-sonnet-4-6" value={state.form.modelId} />
      ) : (
        <select aria-label="模型" className="form-control" disabled={!state.modelSelectAvailable || discovery?.busy} onChange={(event) => state.updateField('modelId', event.target.value)} value={state.form.modelId}>
          {state.modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      )}
      <button className="btn btn-secondary" disabled={manualMode && failed} onClick={() => setManual((current) => !current)} type="button">
        {manualMode ? '使用模型列表' : '手动输入模型 ID'}
      </button>
    </div>
  );
}

function ConnectionActions({ state }) {
  const busy = state.connectionTest.busy && state.connectionTest.providerId === state.form.modelProvider;
  return (
    <footer className="provider-connection-actions">
      <p>保存后，玄武助手会使用这里选定的连接和默认模型。</p>
      <div>
        <button className="btn btn-secondary" disabled={busy} onClick={state.testConnection} type="button">
          {busy ? <Loader2 size={14} className="spin-animation" /> : <PlugZap size={14} />} 测试连接
        </button>
        <button className="btn btn-primary" disabled={state.saving} onClick={state.handleConnectionApply} type="button">
          {state.saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存并设为默认
        </button>
      </div>
    </footer>
  );
}

function ConnectionResult({ state }) {
  const test = state.connectionTest;
  if (test.providerId !== state.form.modelProvider || !test.result) return null;
  return (
    <div className={`provider-test-result ${test.result.ok ? 'success' : 'error'}`} role="status">
      {test.result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
      <span>{test.result.message || (test.result.ok ? '连接成功' : '连接失败')}</span>
    </div>
  );
}

function ConnectionProgress({ oauthMode, state }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const status = piConnectionStatus(state);
  const modelStatus = {
    untested: english ? 'Not tested' : '未测试',
    passed: english ? 'Tested and available' : '已测试可用',
    failed: english ? 'Test failed' : '测试失败',
    testing: english ? 'Testing…' : '测试中…',
  }[status.model];
  return (
    <aside className="provider-progress-rail">
      <span className="provider-console-label">{english ? 'Connection status' : '连接状态'}</span>
      <div className="provider-progress-list" role="status">
        <ProgressStep index="1" label={english ? 'Authorization' : '授权'} ready={status.authorized} value={status.authorized ? (english ? 'Authorized' : '已授权') : (english ? 'Not authorized' : '未授权')} />
        <ProgressStep index="2" label={english ? 'Model' : '模型'} ready={status.model === 'passed'} value={modelStatus} />
      </div>
      <div className="provider-connection-summary">
        <span>{english ? 'Selected connection' : '当前连接'}</span>
        <dl>
          <div><dt>{english ? 'Auth' : '认证'}</dt><dd>{oauthMode ? 'Codex OAuth' : 'API Key'}</dd></div>
          <div><dt>{english ? 'API' : '协议'}</dt><dd>{state.form.api}</dd></div>
          <div><dt>{english ? 'URL' : '地址'}</dt><dd>{oauthMode ? (english ? 'Configured by OAuth' : 'OAuth 自动配置') : connectionTarget(state.form.baseUrl)}</dd></div>
          <div><dt>{english ? 'Model' : '模型'}</dt><dd>{state.form.modelId || (english ? 'Choose a model' : '待选择')}</dd></div>
        </dl>
      </div>
    </aside>
  );
}

function ProgressStep({ index, label, ready, value }) {
  return (
    <div className={`provider-progress-step ${ready ? 'ready' : ''}`}>
      <span>{ready ? '✓' : index}</span>
      <div><strong>{label}</strong><small>{value}</small></div>
    </div>
  );
}

function connectionTarget(value) {
  if (!value) return '待填写';
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function connectionApiLabel(api) {
  if (api === 'openai-codex-responses') return 'ChatGPT OAuth';
  if (api === 'openai-responses') return 'OpenAI Responses';
  if (api === 'openai-completions') return 'OpenAI Chat Completions';
  if (api === 'anthropic') return 'Anthropic Messages';
  if (api === 'google') return 'Google Gemini';
  return api || '模型 API';
}

function connectionDisplayName(provider) {
  const model = provider.models?.[0];
  return `${connectionApiLabel(provider.api)}${model ? ` · ${model}` : ''}`;
}

function SupervisorBehaviorSettings({ state }) {
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
      <SaveRow onSave={state.handleAgentSave} saving={state.saving} />
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

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="supervisor-settings-header">
      <h3>玄武助手</h3>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading} type="button">
        <RefreshCw size={14} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function Field({ children, className = '', hint = '', label }) {
  return (
    <label className={`form-group supervisor-form-field ${className}`}>
      <span className="supervisor-field-label"><span>{label}</span>{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  );
}

function TextField({ form, hint = '', label, name, placeholder = '', updateField }) {
  return (
    <Field hint={hint} label={label}>
      <input className="form-control" value={form[name]} onChange={(event) => updateField(name, event.target.value)} placeholder={placeholder} />
    </Field>
  );
}

function ApiTypeField({ state }) {
  return (
    <Field hint="决定请求格式" label="API 协议">
      <select className="form-control" value={state.form.api} onChange={(event) => state.selectApiProtocol(event.target.value)}>
        <option value="openai-responses">OpenAI Responses</option>
        <option value="openai-completions">OpenAI Chat Completions</option>
        <option value="anthropic">Anthropic Messages</option>
        <option value="google">Google Gemini</option>
      </select>
    </Field>
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

function CodexOAuthPanel({ state }) {
  const status = state.oauthStatus;
  return (
    <div className="supervisor-oauth-panel">
      <div className="supervisor-oauth-heading">
        <div><strong>Codex / ChatGPT OAuth</strong><p>授权成功后自动配置认证，不读取或回显 token。</p></div>
        <OAuthButtons state={state} />
      </div>
      <OAuthStatusLine status={status} />
    </div>
  );
}

function OAuthButtons({ state }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const configured = Boolean(state.oauthStatus?.pi_oauth?.configured);
  const pending = state.oauthStatus?.status === 'pending' && state.oauthStatus?.auth_url;
  return (
    <div className="supervisor-oauth-controls">
      <button className="btn btn-primary" onClick={pending ? state.openPiCodexOAuthUrl : state.startPiCodexOAuthLogin} disabled={state.oauthBusy || configured} type="button">
        {state.oauthBusy ? <Loader2 size={14} className="spin-animation" /> : <KeyRound size={14} />} {configured ? (english ? 'Signed in' : '已登录') : (english ? 'Sign in' : '登录')}
      </button>
      <details className="settings-disclosure supervisor-oauth-more">
        <summary>{english ? 'More' : '更多'}</summary>
        <div className="supervisor-oauth-actions">
          <button className="btn btn-secondary" onClick={state.startPiCodexOAuthLogin} disabled={state.oauthBusy} type="button">{english ? 'Authorize again' : '重新授权'}</button>
          <button className="btn btn-secondary" onClick={state.copyPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">{english ? 'Copy sign-in URL' : '复制登录地址'}</button>
          <button className="btn btn-secondary" onClick={state.openPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">{english ? 'Open authorization page' : '打开授权页'}</button>
          <button className="btn btn-secondary" onClick={state.loadOAuthStatus} disabled={state.oauthBusy} type="button"><RefreshCw size={14} />{english ? 'Refresh status' : '刷新 OAuth 状态'}</button>
          <button className="btn btn-secondary" onClick={state.logoutPiCodexOAuth} disabled={state.oauthBusy || !configured} type="button">{english ? 'Revoke authorization' : '撤销授权'}</button>
        </div>
        {state.oauthStatus?.auth_url ? <code>{state.oauthStatus.auth_url}</code> : null}
      </details>
    </div>
  );
}

function OAuthStatusLine({ status }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const lifecycle = status?.status || status?.pi_oauth?.status || 'idle';
  const configured = Boolean(status?.pi_oauth?.configured);
  const label = configured ? (english ? 'Authorized' : '已授权') : (english ? 'Not authorized' : '未授权');
  const detail = status?.message || (lifecycle === 'pending'
    ? (english ? 'Finish authorization in the browser; signing in again creates a new URL.' : '等待浏览器完成授权；再次登录会生成新的授权地址。')
    : lifecycle === 'error' ? (english ? 'Authorization failed. Try again from More.' : '授权失败，可在“更多”中重新授权。') : '');
  return (
    <div className="supervisor-oauth-status">
      <span><i className={configured ? 'ready' : lifecycle} />{english ? 'Authorization' : '授权'}：{label}</span>
      {detail ? <span className={lifecycle === 'error' ? 'oauth-error' : ''}>{detail}</span> : null}
    </div>
  );
}

function ProviderSummary({ providers }) {
  if (providers.length === 0) return null;
  return (
    <details className="provider-saved-connections">
      <summary>已保存连接 <span>{providers.length}</span></summary>
      <div>
        {providers.map((provider) => (
          <span key={provider.id}><KeyRound size={13} color={provider.api_key_configured ? 'var(--success)' : 'var(--text-muted)'} />{connectionDisplayName(provider)}</span>
        ))}
      </div>
    </details>
  );
}

function SupervisorEnableField({ form, updateField }) {
  return <label className="supervisor-enable-field"><input type="checkbox" checked={form.enabled} onChange={(event) => updateField('enabled', event.target.checked)} /> 启用玄武助手</label>;
}

function SaveRow({ onSave, saving }) {
  return (
    <div className="supervisor-save-row">
      <button className="btn btn-primary" onClick={onSave} disabled={saving} type="button">{saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存运行偏好</button>
      <span>保存名称、思考强度与长期说明，不会改写上方连接凭据；表达风格在“通用”中单独保存。</span>
    </div>
  );
}
