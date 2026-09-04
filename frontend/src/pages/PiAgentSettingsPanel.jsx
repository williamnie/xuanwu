import { ArrowRight, Bot, CheckCircle2, CircleDashed, Eye, KeyRound, Loader2, PlugZap, RefreshCw, Save, Sparkles, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { PanelLoader } from '../components/TurtleLoader';
import { usePiAgentSettingsState } from './piAgentSettingsState';
import './PiAgentSettingsPanel.css';

export default function PiAgentSettingsPanel({ onOpenCodeAgents }) {
  const state = usePiAgentSettingsState();
  return (
    <section className="supervisor-settings-panel">
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.loading ? <PanelLoader label="玄武正在读取 Supervisor 配置…" /> : <SupervisorSettingsForm onOpenCodeAgents={onOpenCodeAgents} state={state} />}
    </section>
  );
}

function SupervisorSettingsForm({ onOpenCodeAgents, state }) {
  return (
    <>
      <SupervisorScopeNote onOpenCodeAgents={onOpenCodeAgents} />
      <SupervisorReadiness state={state} />
      <ConfigurationStage
        description="从 API 协议、地址和 Key 开始；OAuth 只是可选的快捷认证。获取模型后直接保存为默认模型。"
        index="01"
        title="Supervisor 模型连接"
      >
        <ProviderConnectionSettings state={state} />
      </ConfigurationStage>
      <ConfigurationStage
        description="配置玄武的名称、thinking、运行指令，以及对话和通知的表达方式。模型默认值在上方连接区维护。"
        index="02"
        title="身份与运行偏好"
      >
        <SupervisorBehaviorSettings state={state} />
      </ConfigurationStage>
    </>
  );
}

function SupervisorScopeNote({ onOpenCodeAgents }) {
  return (
    <aside className="supervisor-scope-note">
      <div className="supervisor-scope-copy">
        <span>MODEL RUNTIME</span>
        <strong>本页只配置 Supervisor 自己使用的模型连接</strong>
        <p>Codex / Claude Code 作为执行器时使用本机登录态，在 Code Agents 中单独检查。</p>
      </div>
      {onOpenCodeAgents ? (
        <button className="btn btn-secondary supervisor-code-agents-link" onClick={onOpenCodeAgents} type="button">
          查看 Code Agents <ArrowRight size={14} />
        </button>
      ) : null}
    </aside>
  );
}

function SupervisorReadiness({ state }) {
  const connectionSaved = Boolean(state.selectedProvider);
  const modelSelected = Boolean(state.form.modelId.trim());
  return (
    <div className="supervisor-readiness" aria-label="Supervisor readiness">
      <ReadinessItem label="Connection" ready={connectionSaved} value={connectionSaved ? connectionApiLabel(state.form.api) : '待配置'} />
      <ReadinessItem label="Model" ready={modelSelected} value={modelSelected ? state.form.modelId : '待选择'} />
      <ReadinessItem label="Supervisor" ready={state.form.enabled} value={state.form.enabled ? '已启用' : '已停用'} />
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
            <span>{provider.id === 'openai-codex' ? '将同时移除 Supervisor OAuth 授权凭据。' : '将同时撤销为此连接保存的 API Key。'}</span>
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
  return (
    <nav className="provider-mode-tabs" aria-label="连接方式">
      <button aria-pressed={!oauthMode} className={!oauthMode ? 'active' : ''} onClick={state.selectApiMode} type="button"><span>API</span> API 连接</button>
      <button aria-pressed={oauthMode} className={oauthMode ? 'active' : ''} onClick={state.selectOAuthMode} type="button"><span>OA</span> OAuth 快捷登录</button>
    </nav>
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
      <p className="supervisor-oauth-note">目前 Supervisor 快捷登录支持 Codex / ChatGPT。Claude Code 的本机登录仍在 Code Agents 中管理。</p>
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
      <p>一次保存连接参数、模型目录和 Supervisor 默认模型，不需要在其他区块重复选择。</p>
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
  const credentialReady = oauthMode
    ? Boolean(state.oauthStatus?.pi_oauth?.configured)
    : Boolean(state.form.baseUrl.trim() && (state.form.apiKey.trim() || state.selectedProvider?.api_key_configured));
  const modelReady = Boolean(state.form.modelId.trim());
  const applied = Boolean(state.selectedProvider?.models?.includes(state.form.modelId));
  return (
    <aside className="provider-progress-rail">
      <span className="provider-console-label">配置进度</span>
      <div className="provider-progress-list">
        <ProgressStep index="1" label="连接凭据" ready={credentialReady} value={oauthMode ? 'Codex OAuth 快捷登录' : '协议、API 地址与 Key'} />
        <ProgressStep index="2" label="选择模型" ready={modelReady} value="远端目录或手动填写" />
        <ProgressStep index="3" label="保存为默认" ready={applied} value="应用到 Supervisor" />
      </div>
      <div className="provider-connection-summary">
        <span>连接摘要</span>
        <dl>
          <div><dt>认证</dt><dd>{oauthMode ? 'Codex OAuth' : 'API Key'}</dd></div>
          <div><dt>协议</dt><dd>{state.form.api}</dd></div>
          <div><dt>地址</dt><dd>{oauthMode ? 'OAuth 自动配置' : connectionTarget(state.form.baseUrl)}</dd></div>
          <div><dt>模型</dt><dd>{state.form.modelId || '待选择'}</dd></div>
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
      <Field label="运行指令">
        <textarea className="form-control" rows={4} value={state.form.instructions} onChange={(event) => state.updateField('instructions', event.target.value)} />
      </Field>
      <ChatPersonaSettings state={state} />
      <PromptSummaryDebug state={state} />
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
      <div>
        <span className="settings-entry-eyebrow"><Bot size={13} /> XUANWU / MODEL RUNTIME</span>
        <h2>Xuanwu Supervisor</h2>
        <p>配置玄武使用的模型连接、运行偏好与工具授权。</p>
      </div>
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
      <TextField form={state.form} label="Supervisor 名称" name="agentName" updateField={state.updateField} />
      <ThinkingField form={state.form} updateField={state.updateField} />
    </div>
  );
}

function ThinkingField({ form, updateField }) {
  return (
    <Field label="Thinking 强度">
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
  return (
    <div className="supervisor-oauth-actions">
      <button className="btn btn-primary" onClick={state.startPiCodexOAuthLogin} disabled={state.oauthBusy} type="button">
        {state.oauthBusy ? <Loader2 size={14} className="spin-animation" /> : <KeyRound size={14} />} {state.oauthStatus?.pi_oauth?.configured ? '重新授权' : '登录 Codex'}
      </button>
      <button className="btn btn-secondary" onClick={state.copyPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">复制登录地址</button>
      <button className="btn btn-secondary" onClick={state.openPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">打开授权页</button>
      <button aria-label="刷新 OAuth 状态" className="btn btn-secondary supervisor-oauth-refresh" onClick={state.loadOAuthStatus} disabled={state.oauthBusy} title="刷新 OAuth 状态" type="button"><RefreshCw size={14} /></button>
      <button className="btn btn-secondary" onClick={state.logoutPiCodexOAuth} disabled={state.oauthBusy || !state.oauthStatus?.pi_oauth?.configured} type="button">退出 OAuth</button>
    </div>
  );
}

function OAuthStatusLine({ status }) {
  const lifecycle = status?.status || status?.pi_oauth?.status || 'idle';
  const configured = Boolean(status?.pi_oauth?.configured);
  const label = configured
    ? lifecycle === 'error' ? '已连接，重新授权失败' : '已连接'
    : lifecycle === 'pending' ? '等待授权'
      : lifecycle === 'error' ? '授权失败'
        : '未连接';
  const detail = status?.message || (lifecycle === 'pending' ? '等待浏览器完成授权；再次登录会生成新的授权地址。' : '');
  return (
    <div className="supervisor-oauth-status">
      <span><i className={configured ? 'ready' : lifecycle} />Supervisor OAuth：{label}</span>
      {detail ? <span className={lifecycle === 'error' ? 'oauth-error' : ''}>{detail}</span> : null}
      {status?.auth_url ? <code>{status.auth_url}</code> : null}
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
          <span key={provider.id}><KeyRound size={11} color={provider.api_key_configured ? 'var(--success)' : 'var(--text-muted)'} />{connectionDisplayName(provider)}</span>
        ))}
      </div>
    </details>
  );
}

function ChatPersonaSettings({ state }) {
  const form = state.form;
  return (
    <details className="persona-settings-disclosure">
      <summary><Sparkles size={16} /><span><strong>对话与通知表达风格</strong><small>影响 chat 最终回复和通知 message 措辞 · revision {form.personaRevision}</small></span></summary>
      <div className="persona-settings-content">
        <p className="persona-boundary-notice">这里只控制对话和通知的最终措辞，不改变通知是否发送，也不改变权限、审批、工具调用、Issue 状态和完成判定。</p>
        {state.personaConflictDraft ? <PersonaConflictNotice state={state} /> : null}
        <label className="persona-enable-field"><input type="checkbox" checked={form.personaEnabled} onChange={(event) => state.updateField('personaEnabled', event.target.checked)} />启用表达 Persona（默认关闭）</label>
        <Field label={`性格描述 · ${form.personaPersonality.length}/1000`}><textarea className="form-control" maxLength={1000} rows={3} value={form.personaPersonality} onChange={(event) => state.updateField('personaPersonality', event.target.value)} /></Field>
        <Field label={`沟通风格 · ${form.personaCommunicationStyle.length}/2000`}><textarea className="form-control" maxLength={2000} rows={4} value={form.personaCommunicationStyle} onChange={(event) => state.updateField('personaCommunicationStyle', event.target.value)} /></Field>
        <div className="persona-select-grid">
          <Field label="回复长度"><select className="form-control" value={form.personaVerbosity} onChange={(event) => state.updateField('personaVerbosity', event.target.value)}><option value="adaptive">自适应</option><option value="concise">简短</option><option value="detailed">详细</option></select></Field>
          <Field label="语言"><select className="form-control" value={form.personaLanguageMode} onChange={(event) => state.updateField('personaLanguageMode', event.target.value)}><option value="system">跟随系统</option><option value="follow_user">跟随当前用户消息</option></select></Field>
        </div>
        <span className="persona-profile-badge">生效范围：chat / notification.message</span>
      </div>
    </details>
  );
}

function PersonaConflictNotice({ state }) {
  const draft = state.personaConflictDraft;
  return (
    <div className="persona-conflict-notice" role="status">
      <strong>检测到 revision 冲突</strong>
      <span>表单已显示服务器最新配置；下面保留了本地草稿，请比较后选择是否恢复并继续编辑。</span>
      <details><summary>查看本地草稿</summary><pre>{JSON.stringify({ enabled: draft.personaEnabled, personality: draft.personaPersonality, communication_style: draft.personaCommunicationStyle, verbosity: draft.personaVerbosity, language_mode: draft.personaLanguageMode }, null, 2)}</pre></details>
      <div><button className="btn btn-secondary" onClick={state.restorePersonaConflictDraft} type="button">恢复本地草稿</button><button className="btn btn-secondary" onClick={state.dismissPersonaConflictDraft} type="button">使用服务器版本</button></div>
    </div>
  );
}

function PromptSummaryDebug({ state }) {
  const summary = state.promptSummary?.runtime_prompt_summary;
  return (
    <details className="prompt-debug-disclosure">
      <summary><Eye size={16} /><span><strong>运行 Prompt 调试</strong><small>查看当前生效 Prompt 摘要，不回显 API key/token 或 Persona 原文</small></span></summary>
      <div className="prompt-debug-content">
        <div className="prompt-debug-heading">
          <div><strong>当前生效 Prompt 摘要</strong><p>只显示自定义 instructions 与 Persona 安全摘要。</p></div>
          <button className="btn btn-secondary" onClick={state.loadPromptSummary} disabled={state.promptSummaryLoading} type="button">{state.promptSummaryLoading ? <Loader2 size={14} className="spin-animation" /> : <Eye size={14} />} 查看摘要</button>
        </div>
        {summary ? (
          <div className="prompt-debug-summary">
            <span>Custom instructions: {summary.custom_instructions_configured ? `${summary.custom_instructions_chars} chars` : '未配置'}</span>
            <span>Prompt profiles：{summary.profiles?.join(' / ')}</span>
            <span>表达 Persona：{summary.persona_enabled ? `已启用 · ${summary.persona_chars} chars · revision ${summary.persona_revision}` : `未启用 · revision ${summary.persona_revision}`}</span>
            <span>Persona 生效范围：{summary.persona_profiles?.join(' / ') || 'chat'} · language_mode={summary.language_mode}</span>
            <span>注入位置：{summary.injected_after}</span><span>优先级：{summary.conflict_policy}</span>
            {summary.custom_instructions_preview ? <code>{summary.custom_instructions_preview}</code> : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SupervisorEnableField({ form, updateField }) {
  return <label className="supervisor-enable-field"><input type="checkbox" checked={form.enabled} onChange={(event) => updateField('enabled', event.target.checked)} /> 启用 Supervisor</label>;
}

function SaveRow({ onSave, saving }) {
  return (
    <div className="supervisor-save-row">
      <button className="btn btn-primary" onClick={onSave} disabled={saving} type="button">{saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存运行偏好</button>
      <span>只更新名称、Thinking、运行指令与表达风格，不会改写上方连接凭据。</span>
    </div>
  );
}
